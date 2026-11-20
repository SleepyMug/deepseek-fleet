/**
 * The gateway's HTTP/2 surface (fleet-protocol's wire): two sockets, each
 * taking HTTP/2 and HTTP/1.1 alike (fleet-net), for two audiences.
 *
 * - Its clients', its owner's alone, as harnesses and services' servers
 *   reach it: the gateway's own API, `fleet.gateway.v1.Boxes` and `Services`; a
 *   box's API at `/boxes/<id>/`, carried to the helper of the box, which
 *   is started; a service at
 *   `/services/<name>/`, carried to its server, which is told the call is
 *   a client's; and a service's tunnel.
 * - Its boxes', a folder each box mounts: a helper's tunnel, naming its
 *   box; and a service at `/services/<name>/`, which the helper carries
 *   from the box's programs, saying which box, carried to the service's
 *   server, told the box and its labels as the gateway knows them, if the
 *   box was made with the service.
 *
 * Nothing else is taken on either, and what a caller says of fleet's own,
 * in its `fleet-` headers, is said again by the gateway alone.
 * @module @sleepymug/fleet/http/server
 */

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect'
import { connectNodeAdapter } from '@connectrpc/connect-node'
import { HEADERS, HELPER_PROTOCOL, routeOf, tokenOf, TUNNEL_PATH, TUNNEL_PROTOCOL, encodeCaller, type TunnelKind } from '@sleepymug/fleet-protocol/wire'
import { Reason } from '@sleepymug/fleet-protocol/gateway'
import { forward, listen, refuse, type Listener, type Request, type Response, type TunnelRequest } from '@sleepymug/fleet-net'
import { boxesRoutes } from '../api/boxes.ts'
import { servicesRoutes } from '../api/services.ts'
import { reasonOf } from '../failure.ts'
import type { FleetGateway } from '../gateway.ts'
import { messageOf } from '../util/error.ts'

/** Where the gateway listens. */
export interface Sockets {
  /** Its clients' socket, its owner's alone. */
  clients: string
  /** Its boxes' socket, in a folder each box mounts. */
  boxes: string
}

export interface Serving {
  close(): Promise<void>
}

/** Serve `gateway` on its sockets. */
export async function serve(gateway: FleetGateway, sockets: Sockets, log: (message: string) => void = () => {}): Promise<Serving> {
  const api = connectNodeAdapter({
    // A failure that is no ConnectError is the gateway's own bug, which its caller sees only as internal.
    interceptors: [next => async (req) => {
      try {
        return await next(req)
      } catch (error) {
        if (!(error instanceof ConnectError)) log(`${req.method.name} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        throw error
      }
    }],
    routes: (router: ConnectRouter) => {
      boxesRoutes(gateway)(router)
      servicesRoutes(gateway)(router)
    },
  })
  const clients = await listen(sockets.clients, {
    mode: 0o600,
    request: (req, res) => { fromClient(gateway, req, res, api) },
    tunnel: (request) => { void serviceTunnel(gateway, request, log) },
  })
  await mkdir(dirname(sockets.boxes), { recursive: true, mode: 0o700 })
  let boxes: Listener
  try {
    // The boxes' root, whoever it is on this machine, reaches it through the folder the box mounts.
    boxes = await listen(sockets.boxes, {
      mode: 0o666,
      request: (req, res) => { fromBox(gateway, req, res) },
      tunnel: (request) => { boxTunnel(gateway, request, log) },
    })
  } catch (error) {
    await clients.close()
    throw error
  }
  return {
    close: async () => {
      await Promise.allSettled([clients.close(), boxes.close()])
    },
  }
}

/** Whether a header is fleet's own, which only the gateway says. */
const fleets = (name: string): boolean => name.startsWith('fleet-')

/** A call on the clients' socket. */
function fromClient(gateway: FleetGateway, req: Request, res: Response, api: ReturnType<typeof connectNodeAdapter>): void {
  const route = routeOf(req.url ?? '')
  if (route === undefined) {
    refuse(req, res, new ConnectError(`fleet: nothing is at ${req.url ?? ''}`, Code.NotFound))
    return
  }
  if (route.kind === 'gateway') {
    api(req, res)
    return
  }
  if (route.kind === 'service') {
    let registration
    try {
      registration = gateway.serviceFor(route.name)
    } catch (error) {
      refuse(req, res, ConnectError.from(error))
      return
    }
    forward(req, res, registration.upstream, { path: route.path, drop: fleets, headers: { [HEADERS.caller]: encodeCaller({ caller: { case: 'client', value: {} } }) } })
    return
  }
  toBox(gateway, route.box, route.path, req, res)
}

/** A call of a box's API, carried to its helper: the box must be started, which the call does not do. */
function toBox(gateway: FleetGateway, box: string, path: string, req: Request, res: Response): void {
  try {
    forward(req, res, gateway.box(box).started().upstream, { path, drop: fleets })
  } catch (error) {
    refuse(req, res, ConnectError.from(error))
  }
}

/** A call on the boxes' socket: a box's program's, to a service the box has, the box the one whose token its helper says. */
function fromBox(gateway: FleetGateway, req: Request, res: Response): void {
  const route = routeOf(req.url ?? '')
  const box = gateway.boxOfToken(tokenOf(req.headers.authorization))
  if (route?.kind !== 'service') {
    refuse(req, res, new ConnectError(`fleet: a box reaches services alone, at /services/<name>/, not ${req.url ?? ''}`, Code.NotFound))
    return
  }
  try {
    if (box === undefined) throw new ConnectError('fleet: the call says no token of a box known here', Code.PermissionDenied)
    const registration = gateway.serviceFor(route.name, box)
    const caller = encodeCaller({ caller: { case: 'box', value: { id: box, labels: { ...gateway.labelsOf(box) } } } })
    // The box's token is the gateway's and the box's alone.
    forward(req, res, registration.upstream, { path: route.path, drop: name => fleets(name) || name === 'authorization', headers: { [HEADERS.caller]: caller } })
  } catch (error) {
    refuse(req, res, ConnectError.from(error))
  }
}

/** A service's server's tunnel, on the clients' socket, naming the service and its spec. */
async function serviceTunnel(gateway: FleetGateway, request: TunnelRequest, log: (message: string) => void): Promise<void> {
  if (!isTunnel(request, 'service')) {
    request.refuse(400, `fleet: a service's tunnel is a WebSocket at ${TUNNEL_PATH}, its subprotocol ${TUNNEL_PROTOCOL}, naming the service and its spec`)
    return
  }
  const name = String(request.headers[HEADERS.service] ?? '')
  try {
    const spec = await gateway.specForTunnel(name, String(request.headers[HEADERS.spec] ?? ''))
    // Checked again now that the spec is found, so that two servers of one name cannot both be taken.
    if (gateway.registrations.get(name) !== undefined) {
      request.refuse(409, `fleet: another server serves ${name} now`, { [HEADERS.reason]: Reason[Reason.NAME_TAKEN] })
      return
    }
    gateway.registrations.register(spec, request.accept(TUNNEL_PROTOCOL))
  } catch (error) {
    const reason = reasonOf(error)
    const status = error instanceof ConnectError ? statusOf(error.code) : 500
    if (status === 500) log(`could not take the tunnel of ${name}: ${messageOf(error)}`)
    request.refuse(status, messageOf(error), reason === undefined ? {} : { [HEADERS.reason]: Reason[reason] })
  }
}

/** A box's helper's tunnel, on the boxes' socket, saying its box's token. */
function boxTunnel(gateway: FleetGateway, request: TunnelRequest, log: (message: string) => void): void {
  const box = gateway.boxOfToken(tokenOf(request.headers.authorization))
  if (!isTunnel(request, 'box')) {
    request.refuse(400, `fleet: a box's tunnel is a WebSocket at ${TUNNEL_PATH}, its subprotocol ${TUNNEL_PROTOCOL}, saying its box's token`)
    return
  }
  if (request.headers[HEADERS.helperProtocol] !== String(HELPER_PROTOCOL)) {
    request.refuse(426, `fleet: the box's helper speaks version ${String(request.headers[HEADERS.helperProtocol] ?? 'none')}, not ${HELPER_PROTOCOL}: make the box from a newer image`)
    return
  }
  if (box === undefined) {
    request.refuse(404, 'fleet: no box known here has the token the tunnel says', { [HEADERS.reason]: Reason[Reason.NO_BOX] })
    return
  }
  try {
    gateway.attachHelper(box, request.accept(TUNNEL_PROTOCOL))
  } catch (error) {
    log(`could not take the tunnel of ${box}: ${messageOf(error)}`)
    request.refuse(500, messageOf(error))
  }
}

/** Whether `request` asks for a tunnel of `kind`, at fleet's path, speaking fleet's subprotocol. */
function isTunnel(request: TunnelRequest, kind: TunnelKind): boolean {
  return request.path === TUNNEL_PATH && request.headers[HEADERS.tunnel] === kind && request.protocols.includes(TUNNEL_PROTOCOL)
}

/** The HTTP status of a refused tunnel, by its error's code. */
function statusOf(code: Code): number {
  switch (code) {
    case Code.NotFound: return 404
    case Code.AlreadyExists: return 409
    case Code.FailedPrecondition: return 412
    case Code.InvalidArgument: return 400
    case Code.PermissionDenied: return 403
    default: return 500
  }
}

