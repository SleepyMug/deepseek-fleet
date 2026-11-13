/**
 * The gateway's client (fleet-protocol's fleet wire): one connection to
 * the gateway's socket, which carries every request the client asks, and
 * holds its leases and the services it registered, as long as it lasts. A
 * connection the gateway loses is made again, after a pause, its services
 * registered again, its leases and its watches taken again; what was asked
 * on it fails, and is the asker's to ask again.
 * @module @sleepymug/fleet-sdk/client
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  FLEET_PROTOCOL, fleetSocket, type BoxInfo, type BoxSpec, type BoxState, type ClientMessage, type GatewayMessage, type Occupant, type Op,
  type OpEvent, type Ops, type Preamble, type ServiceInfo,
} from '@sleepymug/fleet-protocol/fleet'
import type { EventOf, Method, Methods } from '@sleepymug/fleet-protocol/helper'

/** A failure the gateway reported for a request, with its code, such as `BOX_GONE`, or an `FsError`'s, if it had one. */
export class FleetError extends Error {
  override name = 'FleetError'

  constructor(message: string, readonly code?: string) {
    super(message)
  }
}

/** No gateway answers on the socket. */
export class FleetUnreachable extends Error {
  override name = 'FleetUnreachable'
}

export interface ClientOptions {
  /** The gateway's socket: `$FLEET_SOCKET`, or `fleet.sock` in the fleet home, by default. */
  socket?: string
  /** Say what went wrong outside a request, such as a connection lost; nothing by default. */
  log?: (message: string) => void
}

/** A service, as its server registers it: what the gateway puts in its boxes, and what serves each connection from one. */
export interface ServiceDefinition {
  name: string
  description: string
  /** A node package installed on this host, absolute, which the gateway puts in each box that has the service, its commands on the PATH. */
  package: string
  /** What it adds to the environment of every process in a box that has it. */
  env?: Record<string, string>
  /**
   * Serve one connection a program in a box opened to the service's socket
   * there, as a socket on this host, which `from` says the box of, as the
   * gateway knows it; what follows is the program's.
   */
  serve(connection: Socket, from: Preamble): void
}

/** A service registered, which the client registers again on a connection made again, until it is unregistered. */
export interface Registration {
  readonly info: ServiceInfo
  unregister(): Promise<void>
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  event?: (value: unknown) => void
}

/** A lease the client holds, which it takes again on a connection made again. */
interface Held {
  box: string
  occupant: Occupant
  /** The gateway's id of it, on the connection now; undefined while it is asked for. */
  id?: string
  released: boolean
}

export class Fleet {
  private socket: Socket | undefined
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private connecting: Promise<void> | undefined
  private closed = false
  private readonly services = new Map<string, { definition: ServiceDefinition; endpoint: string }>()
  private readonly held = new Set<Held>()
  /** The watches the client follows, each of which it asks for again on a connection made again. */
  private readonly watching = new Set<{ follow: () => void }>()
  private endpoints: { dir: string; servers: Map<string, Server> } | undefined
  readonly path: string
  private readonly log: (message: string) => void

  private constructor(options: ClientOptions) {
    this.path = options.socket ?? fleetSocket()
    this.log = options.log ?? (() => {})
  }

  /** Connect to the gateway, which must answer now. */
  static async connect(options: ClientOptions = {}): Promise<Fleet> {
    const client = new Fleet(options)
    await client.ensure()
    return client
  }

  /** Ask the gateway an op, and give its result; `onEvent` is told each event it sends first; aborting `signal` cancels it. */
  async request<O extends Op>(op: O, params: Ops[O]['params'], options: { onEvent?: (event: OpEvent<O>) => void; signal?: AbortSignal } = {}): Promise<Ops[O]['result']> {
    if (this.closed) throw new Error('fleet: the client is closed')
    await this.ensure()
    const { signal } = options
    signal?.throwIfAborted()
    const id = this.nextId++
    return await new Promise<Ops[O]['result']>((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(id)
        this.send({ type: 'cancel', id })
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener('abort', abort); resolve(value as Ops[O]['result']) },
        reject: (error) => { signal?.removeEventListener('abort', abort); reject(error) },
        event: options.onEvent as ((value: unknown) => void) | undefined,
      })
      this.send({ type: 'request', id, op, params })
    })
  }

  create(spec: BoxSpec = {}): Promise<BoxInfo> {
    return this.request('box.create', spec)
  }

  list(labels?: Record<string, string>): Promise<BoxInfo[]> {
    return this.request('box.list', labels === undefined ? {} : { labels })
  }

  /** A box, by its id, to ask of. */
  box(id: string): FleetBox {
    return new FleetBox(this, id)
  }

  /**
   * Register a service: its endpoint, a socket of the client's own, serves
   * each connection the gateway passes on, once it has read which box it comes
   * from; the gateway stages its package and puts it in each box that has it.
   */
  async register(definition: ServiceDefinition): Promise<Registration> {
    if (this.services.has(definition.name)) throw new Error(`fleet: the service ${definition.name} is registered already`)
    const endpoint = await this.listen(definition)
    this.services.set(definition.name, { definition, endpoint })
    try {
      const info = await this.request('service.register', specOf(definition, endpoint))
      return {
        info,
        unregister: async () => {
          if (!this.services.delete(definition.name)) return
          await this.request('service.unregister', { name: definition.name }).catch(() => {})
          await this.unlisten(definition.name)
        },
      }
    } catch (error) {
      this.services.delete(definition.name)
      await this.unlisten(definition.name)
      throw error
    }
  }

  /** Close the connection: the gateway drops the client's leases and services. */
  async close(): Promise<void> {
    this.closed = true
    this.socket?.destroy()
    for (const server of this.endpoints?.servers.values() ?? []) server.close()
    if (this.endpoints !== undefined) await rm(this.endpoints.dir, { recursive: true, force: true })
    this.endpoints = undefined
  }

  /** @internal Hold a box, as {@link FleetBox.lease} does. */
  async hold(box: string, occupant: Occupant, start: boolean): Promise<() => Promise<void>> {
    const held: Held = { box, occupant, released: false }
    this.held.add(held)
    try {
      held.id = (await this.request('box.lease', { box, occupant, start })).lease
    } catch (error) {
      this.held.delete(held)
      throw error
    }
    return async () => {
      if (held.released) return
      held.released = true
      this.held.delete(held)
      const lease = held.id
      held.id = undefined
      if (lease !== undefined) await this.request('box.release', { lease }).catch(() => {})
    }
  }

  /** @internal Follow a box's state, as {@link FleetBox.watch} does. */
  watch(box: string, listener: (state: BoxState | 'removed') => void): () => void {
    const controller = new AbortController()
    const watch = {
      follow: (): void => {
        void this.request('box.watch', { box }, { signal: controller.signal, onEvent: ({ state }) => { listener(state) } })
          // Ended by the box's removal; a connection lost is followed again once it is made again.
          .then(() => { this.watching.delete(watch) }, () => {})
      },
    }
    this.watching.add(watch)
    watch.follow()
    return () => {
      this.watching.delete(watch)
      controller.abort(new Error('unwatched'))
    }
  }

  private send(message: ClientMessage): void {
    this.socket?.write(`${JSON.stringify(message)}\n`)
  }

  /** A connection to the gateway, made if there is none. */
  private ensure(): Promise<void> {
    if (this.socket !== undefined && !this.socket.destroyed && this.connecting === undefined) return Promise.resolve()
    this.connecting ??= this.open().finally(() => { this.connecting = undefined })
    return this.connecting
  }

  private async open(): Promise<void> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const connection = createConnection(this.path)
      connection.once('connect', () => { resolve(connection) })
      connection.once('error', (error: NodeJS.ErrnoException) => {
        reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
          ? new FleetUnreachable(`no gateway at ${this.path}: is \`fleet serve\` running?`, { cause: error })
          : error)
      })
    })
    const greeted = Promise.withResolvers<void>()
    socket.on('error', () => {})
    const lines = createInterface({ input: socket, crlfDelay: Infinity })
    // A connection reset, as by a gateway killed, fails its lines too; its close connects again.
    lines.on('error', () => {})
    lines.on('line', (line) => {
      let message: GatewayMessage
      try {
        message = JSON.parse(line) as GatewayMessage
      } catch {
        socket.destroy()
        return
      }
      if (message.type === 'hello') {
        greeted.resolve()
        return
      }
      if (message.type === 'error' && message.id === 0) {
        greeted.reject(new Error(message.message))
        return
      }
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      if (message.type === 'event') pending.event?.(message.value)
      else {
        this.pending.delete(message.id)
        if (message.type === 'result') pending.resolve(message.value)
        else pending.reject(new FleetError(message.message, message.code))
      }
    })
    let ready = false
    socket.once('close', () => {
      greeted.reject(new Error(`fleet: the gateway at ${this.path} closed the connection`))
      if (this.socket !== socket) return
      this.socket = undefined
      const lost = new Error(`fleet: the connection to the gateway at ${this.path} was lost`)
      for (const pending of this.pending.values()) pending.reject(lost)
      this.pending.clear()
      // A connection that never was is the asker's failure, not one to make again.
      if (ready && !this.closed) this.reconnect()
    })
    this.socket = socket
    this.send({ type: 'hello', protocol: FLEET_PROTOCOL })
    try {
      await greeted.promise
    } catch (error) {
      socket.destroy()
      throw error
    }
    ready = true
  }

  /** Make the connection again, after a pause longer each time, and take back what the client holds. */
  private reconnect(): void {
    this.log(`lost the gateway at ${this.path}; connecting again`)
    void (async () => {
      for (let pause = 100; !this.closed; pause = Math.min(pause * 2, 2_000)) {
        await new Promise((resolve) => { setTimeout(resolve, pause).unref() })
        try {
          await this.ensure()
          break
        } catch {
          // Not there yet.
        }
      }
      if (this.closed) return
      this.log(`connected again to the gateway at ${this.path}`)
      for (const [name, { definition, endpoint }] of this.services) {
        await this.request('service.register', specOf(definition, endpoint)).catch((error: unknown) => {
          this.log(`could not register the service ${name} again: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      for (const held of this.held) {
        held.id = undefined
        // Occupied again, not started: what held it asks for the box again as it needs it.
        void this.request('box.lease', { box: held.box, occupant: held.occupant, start: false }).then(({ lease }) => {
          if (held.released) void this.request('box.release', { lease }).catch(() => {})
          else held.id = lease
        }, () => {})
      }
      for (const watch of this.watching) watch.follow()
    })()
  }

  /** A socket of the client's own for a service's connections, each read up to the line that says its box, then served. */
  private async listen(definition: ServiceDefinition): Promise<string> {
    this.endpoints ??= { dir: await mkdtemp(join(tmpdir(), 'fleet-service-')), servers: new Map() }
    const path = join(this.endpoints.dir, `${definition.name}.sock`)
    const server = createServer({ allowHalfOpen: true }, (connection) => { accept(connection, definition, this.log) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.endpoints.servers.set(definition.name, server)
    return path
  }

  private async unlisten(name: string): Promise<void> {
    const server = this.endpoints?.servers.get(name)
    this.endpoints?.servers.delete(name)
    await new Promise<void>((resolve) => { if (server === undefined) resolve(); else server.close(() => { resolve() }) })
  }
}

/**
 * Read a connection's first line, the box it comes from, and serve the
 * rest, which flows once the service reads it, as with a `data` listener.
 */
function accept(connection: Socket, definition: ServiceDefinition, log: (message: string) => void): void {
  let received = Buffer.alloc(0)
  connection.on('error', () => {})
  const readable = (): void => {
    for (let chunk = connection.read() as Buffer | null; chunk !== null; chunk = connection.read() as Buffer | null) {
      received = Buffer.concat([received, chunk])
      const end = received.indexOf(0x0a)
      if (end === -1) continue
      connection.off('readable', readable)
      let from: Preamble
      try {
        from = JSON.parse(received.subarray(0, end).toString('utf8')) as Preamble
        if (typeof from.box !== 'string' || typeof from.labels !== 'object' || from.labels === null) throw new Error('no box')
      } catch {
        connection.destroy()
        return
      }
      if (end + 1 < received.length) connection.unshift(received.subarray(end + 1))
      try {
        definition.serve(connection, from)
      } catch (error) {
        log(`the service ${definition.name} could not serve a connection of ${from.box}: ${error instanceof Error ? error.message : String(error)}`)
        connection.destroy()
      }
      return
    }
  }
  connection.on('readable', readable)
}

function specOf({ name, description, package: root, env }: ServiceDefinition, endpoint: string): Ops['service.register']['params'] {
  return { name, description, package: root, endpoint, ...env === undefined ? {} : { env } }
}

/** A box of the gateway's, as a client asks of it. */
export class FleetBox {
  constructor(private readonly client: Fleet, readonly id: string) {}

  get(): Promise<BoxInfo> {
    return this.client.request('box.get', { box: this.id })
  }

  /**
   * A request of the box's helper: with `hold`, the default, occupying the
   * box while it runs, starting it if need be; without, of a started box.
   */
  request<M extends Method>(method: M, params: Methods[M]['params'], options: { onEvent?: (event: EventOf<M>) => void; hold?: boolean; signal?: AbortSignal } = {}): Promise<Methods[M]['result']> {
    const { onEvent, hold, signal } = options
    return this.client.request('box.request', { box: this.id, method, params, ...hold === undefined ? {} : { hold } } as never, {
      ...onEvent === undefined ? {} : { onEvent: onEvent as never },
      ...signal === undefined ? {} : { signal },
    }) as Promise<Methods[M]['result']>
  }

  /**
   * Occupy the box, so that it is not stopped for being idle, until the
   * returned release; with `start`, the default, once it is started.
   */
  lease(occupant: Occupant, { start = true }: { start?: boolean } = {}): Promise<() => Promise<void>> {
    return this.client.hold(this.id, occupant, start)
  }

  /** Follow the box's state: `listener` is told it now, and on each change, until the returned stop, or the box's removal. */
  watch(listener: (state: BoxState | 'removed') => void): () => void {
    return this.client.watch(this.id, listener)
  }

  async start(): Promise<void> {
    await this.client.request('box.start', { box: this.id })
  }

  async stop(): Promise<void> {
    await this.client.request('box.stop', { box: this.id })
  }

  async stopWhenVacant(): Promise<void> {
    await this.client.request('box.stopWhenVacant', { box: this.id })
  }

  async remove(): Promise<void> {
    await this.client.request('box.remove', { box: this.id })
  }

  /** Copy a host file to a path in the box, or a host folder's contents into a folder there. */
  async copyIn(from: string, to: string): Promise<void> {
    await this.client.request('box.copyIn', { box: this.id, from, to })
  }

  /** Copy a box folder's contents into a host folder. */
  async copyOut(from: string, to: string): Promise<void> {
    await this.client.request('box.copyOut', { box: this.id, from, to })
  }

  /** Run a program in the box for bytes: `input`, a host file, its stdin; its stdout to `output`, a host file, or given back. */
  async pipe(argv: string[], io: { input?: string; output?: string } = {}): Promise<string> {
    return (await this.client.request('box.pipe', { box: this.id, argv, ...io })).stdout
  }

  /**
   * Run a program in the started box, as its root, without a shell, and give
   * back what it wrote to stdout; an exit other than 0 fails, with what it
   * wrote to stderr.
   */
  async exec(argv: string[]): Promise<string> {
    const { code, signal, stdout, stderr } = await this.request('exec', { argv })
    if (code !== 0) {
      const ended = signal === null ? `exited with ${String(code)}` : `was killed by ${signal}`
      throw new Error(`fleet: ${argv[0]} in ${this.id} ${ended}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`)
    }
    return stdout
  }
}
