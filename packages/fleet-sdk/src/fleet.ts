/**
 * The gateway's client: one HTTP/2 connection to the gateway's socket,
 * dialed again as a call needs it once it is lost, as after the gateway
 * restarts, which carries every call the client makes: of the gateway's
 * own API, of its boxes' (./box.ts), and of its services. A service's
 * server serves it through the client too (./serve.ts), over a tunnel of
 * its own. What the client holds, its leases, watches and services, it lets
 * go as it closes.
 * @module @sleepymug/fleet-sdk/fleet
 */

import type { DescService, MessageInitShape } from '@bufbuild/protobuf'
import { createClient, type Client } from '@connectrpc/connect'
import { type Box, Boxes, type CreateBoxRequestSchema, type Service, Services } from '@sleepymug/fleet-protocol/fleet'
import { fleetSocket } from '@sleepymug/fleet-protocol/home'
import { servicePath } from '@sleepymug/fleet-protocol/wire'
import { connectTransport, dial, type Dialed } from '@sleepymug/fleet-net'
import { FleetBox } from './box.ts'
import { FleetUnreachable } from './errors.ts'
import { serveService, type Registration, type ServiceDefinition } from './serve.ts'

export interface ConnectOptions {
  /** The gateway's socket: `$FLEET_SOCKET`, or `fleet.sock` in the fleet home, without it. */
  socket?: string
  /** Told what goes wrong outside a call, as a tunnel lost. */
  log?: (message: string) => void
}

export class Fleet {
  /** The gateway's boxes, as its API has them. */
  readonly boxes: Client<typeof Boxes>
  /** The gateway's services, as its API has them. */
  readonly services: Client<typeof Services>
  private readonly closing = new AbortController()
  private readonly registrations = new Set<Registration>()

  private constructor(readonly socket: string, private readonly upstream: Dialed, private readonly log: (message: string) => void) {
    const transport = connectTransport(upstream)
    this.boxes = createClient(Boxes, transport)
    this.services = createClient(Services, transport)
  }

  /**
   * A client of the gateway on `socket`, which must answer now.
   * @throws FleetUnreachable when no gateway answers.
   */
  static async connect({ socket = fleetSocket(), log = () => {} }: ConnectOptions = {}): Promise<Fleet> {
    const fleet = new Fleet(socket, dial(socket), log)
    try {
      await fleet.services.list({})
    } catch (error) {
      fleet.upstream.close()
      throw new FleetUnreachable(socket, error)
    }
    return fleet
  }

  /** Make a box, stopped, with the services it names, each as registered now. */
  create(spec: MessageInitShape<typeof CreateBoxRequestSchema> = {}): Promise<Box> {
    return this.boxes.create(spec)
  }

  /** Every box, oldest first, or those whose labels hold each of `labels`. */
  async list(labels: Record<string, string> = {}): Promise<Box[]> {
    return (await this.boxes.list({ labels })).boxes
  }

  /** A box, to ask of. */
  box(id: string): FleetBox {
    return new FleetBox(id, this.boxes, this.upstream, this.closing.signal)
  }

  /** The services registered now. */
  async serviceList(): Promise<Service[]> {
    return (await this.services.list({})).services
  }

  /** A service's client, which calls it through the gateway as this client's. */
  client<T extends DescService>(name: string, service: T): Client<T> {
    return createClient(service, connectTransport(this.upstream, servicePath(name)))
  }

  /** Serve a service to the gateway, and settle once it is registered; it is for as long as its tunnel lasts, or this client does. */
  async serve(definition: ServiceDefinition): Promise<Registration> {
    const registration = await serveService(definition, { socket: this.socket, services: this.services, log: this.log })
    this.registrations.add(registration)
    return {
      get spec() { return registration.spec },
      close: () => {
        this.registrations.delete(registration)
        registration.close()
      },
    }
  }

  /** Close the client: its services' tunnels, its leases and watches, and its connection. */
  async close(): Promise<void> {
    this.closing.abort()
    for (const registration of this.registrations) registration.close()
    this.registrations.clear()
    this.upstream.close()
  }
}
