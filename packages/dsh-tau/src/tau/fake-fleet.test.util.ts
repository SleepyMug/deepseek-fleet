/**
 * fleet's gateway, for the tests: a fake of the runs' {@link FleetPort},
 * whose boxes are folders, each serving the box's API, `fleet.box.v1.Box`,
 * in this process, as far as the runs use it: trees put and got, what is at
 * a path, and programs spawned, as the test says each ends.
 * @module @sleepymug/dsh-tau/tau/fake-fleet.test.util
 */

import { lstat, mkdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import { Code, ConnectError, createClient, createRouterTransport, type ConnectRouter } from '@connectrpc/connect'
import { Box, FileInfoSchema, FileType, GetResponseSchema, SpawnResponseSchema } from '@sleepymug/fleet-protocol/box'
import { FailureSchema, Reason } from '@sleepymug/fleet-protocol/gateway'
import { packTree, pathEntry, unpackTree, writeTar } from '@sleepymug/fleet-pack'
import type { BoxApi, BoxSpec, BoxState, FleetBoxPort, FleetPort, ServiceInfo } from './ports.ts'

/**
 * What the agent leaves in the box, by path: a file's text, null for a
 * folder, or `{ link }` for a symlink.
 */
export type Left = Record<string, string | null | { link: string }>

/** A failure of the gateway's, with its reason, as fleet-sdk's client throws one. */
function failed(message: string, reason: Reason): ConnectError {
  return new ConnectError(message, Code.NotFound, undefined, [{ desc: FailureSchema, value: { reason } }])
}

/** A box of the fake gateway's. */
interface FakeBox {
  spec: BoxSpec
  state: BoxState
  occupants: Set<symbol>
  /** To stop as soon as nothing occupies it. */
  soon: boolean
  /** Whether what the agent left is in it yet. */
  left: boolean
  watchers: Set<(state: BoxState | 'removed') => void>
}

/**
 * The gateway, as a record of what is done with its boxes, failing the
 * verb `failing` names. Each box has its files in a folder of `work`; what
 * `left` says the agent left is put there once the run's outputs are first
 * got back. A box starts as a lease or a call that holds it asks; what
 * stops it is a stop, or a stop when vacant once nothing occupies it.
 */
export class FakeFleet implements FleetPort {
  readonly calls: string[] = []
  readonly made = new Map<string, FakeBox>()
  failing: string | undefined
  left: Left
  /** The services registered, which every box is made with. */
  registered: ServiceInfo[] = []
  /** How a process a box spawns, such as a run's init, ends, after writing what it writes: by default at once, with 0, writing nothing. */
  spawn: (program: { argv: string[]; cwd: string }, write: (stream: 'stdout' | 'stderr', text: string) => void, signal: AbortSignal) => Promise<{ code: number | null; signal: string | null }> =
    async () => ({ code: 0, signal: null })
  private made_ = 0

  constructor(private readonly work: string, left: Left = {}) {
    this.left = { ...left }
  }

  /** Where a box has its files. */
  root(id: string): string {
    return join(this.work, 'boxes', id)
  }

  async create(spec: BoxSpec): Promise<string> {
    const id = `box-${(++this.made_).toString(16).padStart(16, '0')}`
    this.record('create', `create ${id}`)
    this.made.set(id, { spec, state: 'stopped', occupants: new Set(), soon: false, left: false, watchers: new Set() })
    await mkdir(this.root(id), { recursive: true })
    return id
  }

  async services(): Promise<ServiceInfo[]> {
    return this.registered
  }

  /** As if someone removed a box's container by other means. */
  lose(id: string): void {
    this.made.delete(id)
  }

  box(id: string): FleetBoxPort {
    const fleet = this
    const known = (reason = Reason.NO_BOX): FakeBox => {
      const box = this.made.get(id)
      if (box === undefined) throw failed(`no box ${id}`, reason)
      return box
    }
    const set = (box: FakeBox, state: BoxState): void => {
      box.state = state
      for (const watcher of box.watchers) watcher(state)
    }
    const start = (box: FakeBox): void => {
      if (box.state === 'started') return
      fleet.record('start', 'start')
      set(box, 'started')
    }
    const stop = (box: FakeBox): void => {
      fleet.record('stop', 'stop')
      box.soon = false
      set(box, 'stopped')
    }
    // A call that holds the box starts it; one of the box started alone needs it started.
    const api = (holds: boolean): BoxApi => createClient(Box, createRouterTransport(this.routes(id, () => {
      const box = known(Reason.BOX_GONE)
      if (holds) start(box)
      else if (box.state !== 'started') throw new ConnectError(`${id} is not started`, Code.FailedPrecondition, undefined, [{ desc: FailureSchema, value: { reason: Reason.NOT_STARTED } }])
      return box
    })))
    const held = api(true)
    return {
      id,
      api: held,
      started: api(false),
      async services() { return known().spec.services },
      async lease(_occupant, { start: starting = true } = {}) {
        const box = known(Reason.BOX_GONE)
        if (starting) start(box)
        const token = Symbol('lease')
        box.occupants.add(token)
        return async () => {
          if (!box.occupants.delete(token)) return
          if (box.occupants.size === 0 && box.soon && fleet.made.get(id) === box) stop(box)
        }
      },
      watch(listener) {
        const box = fleet.made.get(id)
        listener(box?.state ?? 'removed')
        box?.watchers.add(listener)
        return () => { box?.watchers.delete(listener) }
      },
      async start() { start(known(Reason.BOX_GONE)) },
      async stop() { stop(known()) },
      async stopWhenVacant() {
        const box = known()
        if (box.occupants.size === 0) stop(box)
        else box.soon = true
      },
      async remove() {
        const box = known()
        fleet.record('remove', 'remove')
        fleet.made.delete(id)
        for (const watcher of box.watchers) watcher('removed')
        await rm(fleet.root(id), { recursive: true, force: true })
      },
      async put(archive, to) {
        async function* requests() {
          yield { request: { case: 'path' as const, value: to } }
          for await (const chunk of archive) yield { request: { case: 'chunk' as const, value: chunk } }
        }
        await held.put(requests())
      },
      async *get(from) {
        for await (const { chunk } of held.get({ path: from })) yield chunk
      },
    }
  }

  /** The box `id`'s API, each call taking the box as `reached` gives it. */
  private routes(id: string, reached: () => FakeBox): (router: ConnectRouter) => void {
    const fleet = this
    const at = (path: string): string => join(this.root(id), path)
    return router => router.service(Box, {
      put: async (requests) => {
        reached()
        const iterator = requests[Symbol.asyncIterator]()
        const first = await iterator.next()
        const to = first.done === true || first.value.request.case !== 'path' ? '' : first.value.request.value
        this.record('put', `put ${to}`)
        async function* chunks() {
          for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
            if (next.value.request.case === 'chunk') yield next.value.request.value
          }
        }
        await unpackTree(chunks(), at(to), { followLinks: true })
        return {}
      },
      get: async function* ({ path }) {
        const box = reached()
        fleet.record('get', `get ${path}`)
        if (!box.left) {
          box.left = true
          await fleet.leave(id)
        }
        const info = await lstat(at(path)).catch(() => undefined)
        if (info === undefined) throw new ConnectError(`nothing at ${path}`, Code.NotFound)
        const archive = info.isDirectory() ? packTree(at(path)) : writeTar([await pathEntry(at(path), basename(path)) as never])
        for await (const chunk of archive) yield create(GetResponseSchema, { chunk })
      },
      stat: async ({ path, follow }) => {
        const box = reached()
        if (!box.left) {
          box.left = true
          await this.leave(id)
        }
        const info = await (follow ? stat(at(path)) : lstat(at(path))).catch(() => undefined)
        if (info === undefined) return {}
        const type = info.isFile() ? FileType.FILE : info.isDirectory() ? FileType.DIRECTORY : info.isSymbolicLink() ? FileType.SYMLINK : FileType.OTHER
        return {
          info: create(FileInfoSchema, {
            type, size: BigInt(info.size), mode: info.mode & 0o7777, modified: timestampFromDate(info.mtime),
            target: type === FileType.SYMLINK ? await readlink(at(path)) : '', version: `${info.ino}:${info.size}:${info.mtimeMs}`,
          }),
        }
      },
      spawn: async function* (requests, context) {
        reached()
        const iterator = requests[Symbol.asyncIterator]()
        const first = await iterator.next()
        const start = first.done === true || first.value.request.case !== 'start' ? undefined : first.value.request.value
        const program = { argv: start?.program?.argv ?? [], cwd: start?.program?.cwd ?? '/' }
        fleet.record('spawn', `spawn ${JSON.stringify(program)}`)
        yield create(SpawnResponseSchema, { response: { case: 'started', value: { pid: 1 } } })
        const written: { stream: 'stdout' | 'stderr'; text: string }[] = []
        const { code, signal } = await fleet.spawn(program, (stream, text) => { written.push({ stream, text }) }, context.signal)
        for (const { stream, text } of written) yield create(SpawnResponseSchema, { response: { case: stream, value: Buffer.from(text) } })
        yield create(SpawnResponseSchema, { response: { case: 'exit', value: { ...code === null ? {} : { code }, signal: signal ?? '' } } })
      },
    })
  }

  /** Put what the agent left in the box `id`, as `left` says. */
  private async leave(id: string): Promise<void> {
    for (const [path, what] of Object.entries(this.left).sort(([a], [b]) => a.localeCompare(b))) {
      const at = join(this.root(id), path)
      await mkdir(dirname(at), { recursive: true })
      if (what === null) await mkdir(at, { recursive: true })
      else if (typeof what === 'string') await writeFile(at, what)
      else await symlink(what.link, at)
    }
  }

  /** Record a call; the verb `failing` names fails, as the gateway's do. */
  private record(verb: string, call: string): void {
    this.calls.push(call)
    if (verb === this.failing) throw new ConnectError(`${verb} failed`, Code.Internal)
  }
}
