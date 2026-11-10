/**
 * The fleet host (docs/fleet/index.md): the boxes it made, each a container
 * with fleet's helper in it while it runs, kept as their creators ask and
 * stopped once idle (./managed.ts); the services registered with it, which
 * it puts in the boxes that have them, and whose connections it passes on
 * from each box's channel (./services.ts, ./channel.ts); and the ops its clients ask of them, as
 * fleet-protocol's fleet wire has them, each a client's, whose leases and
 * services last as long as the client does. It knows nothing of whoever
 * uses its boxes, a harness or a service: a box is its id, its labels, and
 * what is in it.
 * @module @sleepymug/fleet/host
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Writable } from 'node:stream'
import { type BoxInfo, type BoxSpec, type BoxState, NO_BOX, type Op, type OpEvent, type Ops } from '@sleepymug/fleet-protocol/fleet'
import { DEFAULT_IMAGE } from '@sleepymug/fleet-protocol/layout'
import type { Method } from '@sleepymug/fleet-protocol/helper'
import { Box, METHODS } from './box/box.ts'
import { Channel } from './channel.ts'
import { type Boxes, ManagedBox, type RunBox } from './managed.ts'
import type { Platform } from './platform.ts'
import { BOX_ID, type BoxRecord, Registry } from './registry.ts'
import { Services } from './services.ts'
import { messageOf } from './util/error.ts'

export { Registry } from './registry.ts'
export { systemPlatform } from './platform.ts'

/** Docker's containers, through `Box`. */
export const dockerBoxes: Boxes = {
  create: (name, { image, env, labels, channel }) => Box.create({ name, image, env, labels, channel }),
  open: name => Box.open(name),
  async state(name) {
    const found = (await Box.list()).find(box => box.name === name)
    return found === undefined ? 'missing' : found.state === 'running' ? 'running' : 'stopped'
  },
}

export interface FleetHostDeps {
  registry: Registry
  /** Where the services' packages are staged. */
  cache: string
  /** Where the boxes' channels are, each in a folder by its box's id. */
  channels: string
  platform: Platform
  /** Docker's, by default. */
  boxes?: Boxes
  /** The image of a box made without one; {@link DEFAULT_IMAGE} by default. */
  image?: string
  /** How long a box nothing occupies runs before it is stopped; 60 s by default. */
  idleStopMs?: number
}

/** A client of the host, whose leases and services last while it does. */
export interface Client {
  readonly leases: Map<string, { box: string; release: () => void }>
}

/** What an op is given besides its params: who asks, where its events go, and what gives it up. */
export interface OpContext<O extends Op> {
  client: Client
  emit: (event: OpEvent<O>) => void
  signal: AbortSignal
}

type Handler<O extends Op> = (params: Ops[O]['params'], context: OpContext<O>) => Promise<Ops[O]['result']>

interface Kept {
  record: BoxRecord
  box: ManagedBox
  watchers: Set<(state: BoxState | 'removed') => void>
  channel: Channel
}

export class FleetHost {
  private readonly kept = new Map<string, Kept>()
  private readonly registry: Registry
  private readonly channels: string
  private readonly platform: Platform
  private readonly boxes: Boxes
  private readonly image: string
  private readonly idleStopMs: number
  readonly services: Services
  private nextLease = 1

  constructor({ registry, cache, channels, platform, boxes = dockerBoxes, image = DEFAULT_IMAGE, idleStopMs = 60_000 }: FleetHostDeps) {
    this.registry = registry
    this.channels = channels
    this.platform = platform
    this.boxes = boxes
    this.image = image
    this.idleStopMs = idleStopMs
    this.services = new Services({ cache, platform, changed: () => { this.resync() } })
  }

  /** Know the boxes the registry has, as a host before this one left them: one still running stops once idle. */
  async load(): Promise<void> {
    for (const record of await this.registry.list()) {
      const kept = await this.keep(record)
      const state = await this.boxes.state(record.id).catch(() => 'stopped' as const)
      if (state === 'running') kept.box.adopt()
    }
  }

  /** A client, for the ops it asks. */
  client(): Client {
    return { leases: new Map() }
  }

  /** Let a client go: its leases released, and its services unregistered. */
  leave(client: Client): void {
    for (const { release } of client.leases.values()) release()
    client.leases.clear()
    this.services.unregisterAll(client)
  }

  /** Ask an op, as a client. */
  async handle<O extends Op>(op: O, params: Ops[O]['params'], context: OpContext<O>): Promise<Ops[O]['result']> {
    if (!Object.hasOwn(this.ops, op)) throw new Error(`fleet: no op ${String(op)}`)
    const handler = this.ops[op] as Handler<O>
    return await handler(params ?? ({} as Ops[O]['params']), context)
  }

  /** Stop the boxes started here, and their channels. */
  async close(): Promise<void> {
    await Promise.all([...this.kept.values()].map(async (kept) => {
      await kept.box.close()
      await kept.channel.close()
    }))
  }

  private readonly ops: { [O in Op]: Handler<O> } = {
    'box.create': async (spec) => await this.create(spec),
    'box.list': async ({ labels } = {}) => [...this.kept.values()]
      .filter(({ record }) => Object.entries(labels ?? {}).every(([key, value]) => record.labels[key] === value))
      .map(kept => infoOf(kept)),
    'box.get': async ({ box }) => infoOf(this.kept_(box)),
    'box.start': async ({ box }) => {
      await this.kept_(box).box.start()
      return null
    },
    'box.stop': async ({ box }) => {
      await this.kept_(box).box.stop()
      return null
    },
    'box.stopWhenVacant': async ({ box }) => {
      await this.kept_(box).box.stopWhenVacant()
      return null
    },
    'box.remove': async ({ box }) => {
      const kept = this.kept_(box)
      await kept.box.remove(async () => {
        await this.registry.delete(box)
        this.kept.delete(box)
      })
      await kept.channel.close()
      await rm(this.channelOf(box), { recursive: true, force: true })
      for (const watcher of kept.watchers) watcher('removed')
      this.platform.log(`removed ${box}`)
      return null
    },
    'box.lease': async ({ box, occupant, start = true }, { client }) => {
      const kept = this.kept_(box)
      if (typeof occupant?.kind !== 'string' || typeof occupant.id !== 'string') throw new TypeError('fleet: a lease is an occupant\'s, { kind, id }')
      const lease = `lease-${this.nextLease++}`
      const release = start ? (await kept.box.hold(occupant)).release : kept.box.occupy(occupant)
      client.leases.set(lease, { box, release })
      return { lease }
    },
    'box.release': async ({ lease }, { client }) => {
      client.leases.get(lease)?.release()
      client.leases.delete(lease)
      return null
    },
    'box.watch': async ({ box }, { emit, signal }) => {
      const kept = this.kept_(box)
      const ended = Promise.withResolvers<null>()
      const watcher = (state: BoxState | 'removed'): void => {
        emit({ state })
        if (state === 'removed') ended.resolve(null)
      }
      kept.watchers.add(watcher)
      const stop = (): void => { ended.resolve(null) }
      signal.addEventListener('abort', stop, { once: true })
      emit({ state: kept.box.state })
      try {
        return await ended.promise
      } finally {
        kept.watchers.delete(watcher)
        signal.removeEventListener('abort', stop)
      }
    },
    'box.request': async ({ box, method, params, hold = true }, { emit }) => {
      if (!(METHODS as string[]).includes(method)) throw new Error(`fleet: no method ${String(method)}`)
      if (method === 'hello' || method.startsWith('services.')) throw new Error(`fleet: ${method} is the host's own`)
      const kept = this.kept_(box)
      const send = (running: RunBox): Promise<unknown> => running.request(method as Method, params as never, emit as never)
      if (!hold) return await send(await kept.box.started()) as never
      const held = await kept.box.hold({ kind: 'request', id: `${method}-${this.platform.newId()}` })
      try {
        return await send(held.box) as never
      } finally {
        held.release()
      }
    },
    'box.copyIn': async ({ box, from, to }) => {
      if (!isAbsolute(from)) throw new TypeError('fleet: a copy is from an absolute path on the host')
      const { box: managed } = this.kept_(box)
      await managed.exclusive(async () => { await (await managed.container()).copyIn(from, to) })
      return null
    },
    'box.copyOut': async ({ box, from, to }) => {
      if (!isAbsolute(to)) throw new TypeError('fleet: a copy is to an absolute path on the host')
      const { box: managed } = this.kept_(box)
      await managed.exclusive(async () => { await (await managed.container()).copyOut(from, to) })
      return null
    },
    'box.pipe': async ({ box, argv, input, output }) => {
      if (!Array.isArray(argv) || argv.length === 0 || !argv.every(arg => typeof arg === 'string')) throw new TypeError('fleet: a pipe takes an argv, the program first')
      for (const path of [input, output]) if (path !== undefined && !isAbsolute(path)) throw new TypeError('fleet: a pipe\'s input and output are absolute paths on the host')
      const held = await this.kept_(box).box.hold({ kind: 'pipe', id: this.platform.newId() })
      try {
        let stdout = ''
        const collect = new Writable({ write(chunk: Buffer, _encoding, done) { stdout += chunk.toString('utf8'); done() } })
        await held.box.pipe(argv, {
          ...input === undefined ? {} : { input: createReadStream(input) },
          output: output === undefined ? collect : createWriteStream(output, { mode: 0o600 }),
        })
        return { stdout }
      } finally {
        held.release()
      }
    },
    'service.register': async (spec, { client }) => await this.services.register(spec, client),
    'service.unregister': async ({ name }, { client }) => {
      this.services.unregister(name, client)
      return null
    },
    'service.list': async () => this.services.list(),
  }

  /** Make a box, stopped, and keep it. */
  private async create(spec: BoxSpec = {}): Promise<BoxInfo> {
    const { image = this.image, labels = {}, env = {}, services, idleStopMs } = spec
    const strings = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(entry => typeof entry === 'string')
    if (typeof image !== 'string' || image === '') throw new TypeError('fleet: a box\'s image is a name')
    if (!strings(labels) || !strings(env)) throw new TypeError('fleet: a box\'s labels and env are strings')
    if (services !== undefined && (!Array.isArray(services) || !services.every(name => typeof name === 'string'))) throw new TypeError('fleet: a box\'s services are names')
    if (idleStopMs !== undefined && (typeof idleStopMs !== 'number' || !Number.isFinite(idleStopMs) || idleStopMs < 0)) throw new TypeError('fleet: a box\'s idleStopMs is a number of milliseconds, 0 or more')
    const id = `box-${this.platform.newId()}`
    if (!BOX_ID.test(id)) throw new Error(`fleet: minted an id that is none: ${id}`)
    const record: BoxRecord = {
      id, image, labels: { ...labels }, env: { ...env }, services: services === undefined ? null : [...services],
      ...idleStopMs === undefined ? {} : { idleStopMs }, createdAt: this.platform.now().toISOString(),
    }
    // The channel's folder first, which the container mounts.
    const channel = await this.listen(record)
    let container: RunBox
    try {
      container = await this.boxes.create(id, {
        image, env: record.env, labels: { ...Object.fromEntries(Object.entries(labels).map(([key, value]) => [`fleet.label.${key}`, value])) }, channel: this.channelOf(id),
      })
    } catch (error) {
      await channel.close()
      await rm(this.channelOf(id), { recursive: true, force: true })
      throw error
    }
    try {
      await this.registry.put(record)
    } catch (error) {
      await container.remove().catch(() => {})
      await channel.close()
      await rm(this.channelOf(id), { recursive: true, force: true })
      throw error
    }
    const kept = await this.keep(record, container, channel)
    this.platform.log(`created ${id}${Object.keys(labels).length === 0 ? '' : `, ${Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(' ')}`}`)
    return infoOf(kept)
  }

  private async keep(record: BoxRecord, container?: RunBox, channel?: Channel): Promise<Kept> {
    const watchers = new Set<(state: BoxState | 'removed') => void>()
    const box = new ManagedBox({
      id: record.id,
      boxes: this.boxes,
      platform: this.platform,
      idleStopMs: record.idleStopMs ?? this.idleStopMs,
      onStarted: running => this.services.provision(running, record),
      onState: (state) => { for (const watcher of watchers) watcher(state) },
    }, container)
    const kept: Kept = { record, box, watchers, channel: channel ?? await this.listen(record) }
    this.kept.set(record.id, kept)
    return kept
  }

  /** Listen on a box's channel, its connections passed on to its services. */
  private async listen(record: BoxRecord): Promise<Channel> {
    // Only the host's owner reaches the channels but through a box's mount.
    await mkdir(this.channels, { recursive: true, mode: 0o700 })
    await chmod(this.channels, 0o700)
    return await Channel.listen(this.channelOf(record.id), service => this.services.taker(record, service))
  }

  private channelOf(id: string): string {
    return join(this.channels, id)
  }

  /** A box the host keeps; another fails. */
  private kept_(id: string): Kept {
    const kept = typeof id === 'string' ? this.kept.get(id) : undefined
    if (kept === undefined) throw Object.assign(new Error(`fleet: no box ${String(id)}`), { code: NO_BOX })
    return kept
  }

  /** Give each started box its services as they are now. */
  private resync(): void {
    for (const { record, box } of this.kept.values()) {
      if (box.state !== 'started') continue
      box.exclusive(async () => {
        if (box.state !== 'started') return
        await this.services.provision(await box.started(), record)
      }).catch((error: unknown) => { this.platform.log(`could not give ${record.id} its services: ${messageOf(error)}`) })
    }
  }
}

function infoOf({ record, box }: Kept): BoxInfo {
  return { ...record, labels: { ...record.labels }, env: { ...record.env }, services: record.services === null ? null : [...record.services], state: box.state }
}
