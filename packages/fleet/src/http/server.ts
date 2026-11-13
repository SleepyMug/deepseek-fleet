/**
 * The gateway's HTTP/2 surface (fleet-protocol's wire): two sockets, each
 * taking HTTP/2 and HTTP/1.1 alike (fleet-net), for two audiences.
 *
 * - Its clients', its owner's alone, as harnesses and services' servers
 *   reach it: the gateway's own API, `fleet.v1.Boxes` and `Services`; a
 *   box's API at `/boxes/<id>/`, carried to the box's helper, the box held
 *   while the call lasts unless the call says not to; a service at
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

import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { dirname } from 'node:path'
import type { Duplex } from 'node:stream'
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect'
import { connectNodeAdapter } from '@connectrpc/connect-node'
import { HEADERS, HELPER_PROTOCOL, routeOf, TUNNEL_PATH, TUNNEL_PROTOCOL, encodeCaller } from '@sleepymug/fleet-protocol/wire'
import { Reason } from '@sleepymug/fleet-protocol/fleet'
import { acceptTunnel, forward, listen, refuse, refuseTunnel, type Listener, type Request, type Response } from '@sleepymug/fleet-net'
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
    routes: (router: ConnectRouter) => {
      boxesRoutes(gateway)(router)
      servicesRoutes(gateway)(router)
    },
  })
  const clients = await listen(sockets.clients, {
    mode: 0o600,
    request: (req, res) => { fromClient(gateway, req, res, api) },
    upgrade: (req, socket, head) => { void serviceTunnel(gateway, req, socket, head, log) },
  })
  await mkdir(dirname(sockets.boxes), { recursive: true, mode: 0o700 })
  let boxes: Listener
  try {
    // The boxes' root, whoever it is on this machine, reaches it through the folder the box mounts.
    boxes = await listen(sockets.boxes, {
      mode: 0o666,
      request: (req, res) => { fromBox(gateway, req, res) },
      upgrade: (req, socket, head) => { boxTunnel(gateway, req, socket, head, log) },
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
  void toBox(gateway, route.box, route.path, req, res)
}

/** A call of a box's API, carried to its helper: the box held while it lasts, unless it says not to, and then only to a box that is started. */
async function toBox(gateway: FleetGateway, box: string, path: string, req: Request, res: Response): Promise<void> {
  try {
    const managed = gateway.box(box)
    if (req.headers[HEADERS.hold] === 'false') {
      forward(req, res, managed.started().upstream, { path, drop: fleets })
      return
    }
    const { link, release } = await managed.hold({ kind: 'call', id: randomBytes(8).toString('hex') })
    res.once('close', release)
    forward(req, res, link.upstream, { path, drop: fleets })
  } catch (error) {
    refuse(req, res, ConnectError.from(error))
  }
}

/** A call on the boxes' socket: a box's program's, to a service the box has. */
function fromBox(gateway: FleetGateway, req: Request, res: Response): void {
  const route = routeOf(req.url ?? '')
  const box = String(req.headers[HEADERS.box] ?? '')
  if (route?.kind !== 'service') {
    refuse(req, res, new ConnectError(`fleet: a box reaches services alone, at /services/<name>/, not ${req.url ?? ''}`, Code.NotFound))
    return
  }
  try {
    if (!gateway.hasBox(box)) throw new ConnectError(`fleet: no box ${box} is known here`, Code.PermissionDenied)
    const registration = gateway.serviceFor(route.name, box)
    const caller = encodeCaller({ caller: { case: 'box', value: { id: box, labels: { ...gateway.labelsOf(box) } } } })
    forward(req, res, registration.upstream, { path: route.path, drop: fleets, headers: { [HEADERS.caller]: caller } })
  } catch (error) {
    refuse(req, res, ConnectError.from(error))
  }
}

/** A service's server's tunnel, on the clients' socket, naming the service and its spec. */
async function serviceTunnel(gateway: FleetGateway, req: IncomingMessage, socket: Duplex, head: Buffer, log: (message: string) => void): Promise<void> {
  if (req.url !== TUNNEL_PATH || req.headers[HEADERS.tunnel] !== 'service' || String(req.headers.upgrade ?? '').toLowerCase() !== TUNNEL_PROTOCOL) {
    refuseTunnel(socket, 400, 'fleet: a service\'s tunnel is an upgrade to fleet-tunnel at /fleet/tunnel, naming the service and its spec')
    return
  }
  const name = String(req.headers[HEADERS.service] ?? '')
  try {
    const spec = await gateway.specForTunnel(name, String(req.headers[HEADERS.spec] ?? ''))
    // Checked again now that the spec is found, so that two servers of one name cannot both be taken.
    if (gateway.registrations.get(name) !== undefined) {
      refuseTunnel(socket, 409, `fleet: another server serves ${name} now`, { [HEADERS.reason]: Reason[Reason.NAME_TAKEN] })
      return
    }
    gateway.registrations.register(spec, acceptTunnel(socket, head, TUNNEL_PROTOCOL))
  } catch (error) {
    const reason = reasonOf(error)
    const status = error instanceof ConnectError ? statusOf(error.code) : 500
    if (status === 500) log(`could not take the tunnel of ${name}: ${messageOf(error)}`)
    refuseTunnel(socket, status, messageOf(error), reason === undefined ? {} : { [HEADERS.reason]: Reason[reason] })
  }
}

/** A box's helper's tunnel, on the boxes' socket, naming its box. */
function boxTunnel(gateway: FleetGateway, req: IncomingMessage, socket: Duplex, head: Buffer, log: (message: string) => void): void {
  const box = String(req.headers[HEADERS.box] ?? '')
  if (req.url !== TUNNEL_PATH || req.headers[HEADERS.tunnel] !== 'box' || String(req.headers.upgrade ?? '').toLowerCase() !== TUNNEL_PROTOCOL) {
    refuseTunnel(socket, 400, 'fleet: a box\'s tunnel is an upgrade to fleet-tunnel at /fleet/tunnel, naming its box')
    return
  }
  if (req.headers[HEADERS.helperProtocol] !== String(HELPER_PROTOCOL)) {
    refuseTunnel(socket, 426, `fleet: the box's helper speaks version ${String(req.headers[HEADERS.helperProtocol] ?? 'none')}, not ${HELPER_PROTOCOL}: make the box from a newer image`)
    return
  }
  if (!gateway.hasBox(box)) {
    refuseTunnel(socket, 404, `fleet: no box ${box}`, { [HEADERS.reason]: Reason[Reason.NO_BOX] })
    return
  }
  try {
    gateway.attachHelper(box, acceptTunnel(socket, head, TUNNEL_PROTOCOL))
  } catch (error) {
    log(`could not take the tunnel of ${box}: ${messageOf(error)}`)
    socket.destroy()
  }
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

