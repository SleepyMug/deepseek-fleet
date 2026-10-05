/**
 * The runs of taus, and their boxes (docs/fleet-core/tau/index.md): it
 * checks a run's call, tau's archive of the run's values with the content of
 * its handles, and the tau (tau's docs/spec/serialization.md), keeps it, and
 * has a box's runtime set the box up from it (fleet-image/tau/endpoint),
 * which places everything where the box has things, with the tau's APIs
 * linked to the clients of the extensions that implement them (./apis.ts); keeps which box each session has (./registry.ts); starts,
 * stops and removes the box, and copies host files into it as they are asked
 * for; keeps the run's result, the archive of what it gave back, which its
 * box packs; and answers the calls the clients in the box make, with the
 * extensions' servers. It never reads or writes a caller's files: the caller
 * packs the call, and puts the result at its paths. It uses nothing of
 * dsh's, so both fleet-core's world (../world/), which serves a tau's
 * session from its box, and the tau service (./service.ts), which makes the
 * session, build on it.
 * @module fleet-core/tau/runs
 */

import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, realpath, rm } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { loadTau } from '@sleepymug/tau'
import { checkResult, placeCall, readCall, readResult, writeResult } from '@sleepymug/tau/call'
import type { Call } from 'fleet-image/helper/protocol'
import { HELPER_NODE, TAU_ENTRY } from 'fleet-image/layout'
import type { Setup } from 'fleet-image/tau/endpoint'
import type { Result, Started, Targets } from 'fleet-protocol/tau'
import { Box, exec } from '../box/box.ts'
import { linkApis, type Exts, type Linked } from './apis.ts'
import type { Caller, Entry, Registry } from './registry.ts'

/** What a run's box is used for. */
export type RunBox = Pick<Box, 'container' | 'start' | 'stop' | 'remove' | 'copyIn' | 'pipe' | 'request'>

/** What a call says of itself, besides the archive. */
export interface About {
  /** The tau's directory, as the caller has it, which names the run. */
  tauDir: string
  /** The caller's folder, absolute, for `fleet`; a tau's session's runs are in its own project. */
  project?: string
  /** Where the caller has each `$out` and `$inout` handle, which `finish` gives back. */
  targets: Targets
}

/** In a session's folder: the run's call; the tau it carries, read from it while the box is set up; and the run's result. */
const CALL = 'call.tar'
const TAU = 'self'
const RESULT = 'result.tar'

/** What the service learns of a call before it makes anything of it. */
interface Accepted {
  /** The tau's root, read from the call, through symlinks. */
  tauRoot: string
  linked: Linked
}

/** `fleet`, on the host. */
export const HOST: Caller = { kind: 'host' }

/** Where the runs get their boxes: Docker's, through `Box`, unless a test stands in. */
export interface Boxes {
  create(name: string): Promise<RunBox>
  open(name: string): Promise<RunBox>
  /** Whether a box's container is there. */
  exists(name: string): Promise<boolean>
}

const dockerBoxes: Boxes = {
  create: name => Box.create({ name }),
  open: name => Box.open(name),
  exists: async name => (await Box.list()).some(box => box.name === name),
}

export class TauRuns {
  /** The box of each session used, opened once, so that its verbs run in order. */
  private readonly boxes = new Map<string, Promise<RunBox>>()
  /** The sessions whose box was started here, which {@link close} stops. */
  private readonly started = new Set<string>()
  /** Each session's last operation on its box, which its next one waits for. */
  private readonly queues = new Map<string, Promise<void>>()
  /**
   * The sessions with a registry entry, each with its project and its
   * working directory in its box, as {@link load} found them and as they
   * were made and removed since.
   */
  private readonly taus = new Map<string, { project: string; cwd: string }>()
  /** Each session's host files copied into its box, or on their way, by their place there. */
  private readonly copies = new Map<string, Map<string, Promise<void>>>()

  constructor(
    private readonly registry: Registry,
    private readonly exts: Exts,
    private readonly log: (message: string) => void,
    private readonly docker: Boxes = dockerBoxes,
  ) {}

  /** Find the sessions the registry has, before anyone asks which sessions are a tau's. */
  async load(): Promise<void> {
    for (const sessionId of await this.registry.list()) {
      const { project, cwd } = await this.registry.get(sessionId)
      this.taus.set(sessionId, { project, cwd })
    }
  }

  /**
   * Set up a box for a run of a call, and leave it stopped. First the call
   * is checked as it comes, before anything is kept or made of it: read
   * whole, as tau's docs/spec/serialization.md has it, the tau it carries
   * read from it, its values bound to the tau, and the tau's APIs linked to
   * the extensions provided. Then the call is kept in the session's folder;
   * the box is created and started, and its runtime sets it up from the call
   * (fleet-image/tau/endpoint), placing it all where it has things, and
   * reports the prompt, the handles and where things are; each API's client
   * is copied in, where the runtime says, and the APIs and what the tau
   * exposes linked; and the session is registered. A failure removes the box
   * and the session's folder.
   * @param call - tau's archive of the call, which carries the tau.
   * @param caller - `fleet`, on the host, or a tau's session, from its box, whose runs are in its project.
   */
  async create(call: AsyncIterable<Uint8Array>, about: About, caller: Caller = HOST): Promise<Started> {
    const sessionId = `session-${randomUUID()}`
    const project = await this.projectFor(caller, about)
    const folder = this.registry.folder(sessionId)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    try {
      const accepted = await this.accept(call, folder, about)
      return await this.setUp(sessionId, accepted, about, project, caller)
    } catch (error) {
      await rm(folder, { recursive: true, force: true })
      throw error
    } finally {
      await rm(join(folder, TAU), { recursive: true, force: true })
    }
  }

  /** Check a call as it comes, writing it to the session's folder, and read its tau there. */
  private async accept(call: AsyncIterable<Uint8Array>, folder: string, about: About): Promise<Accepted> {
    const tauDir = join(folder, TAU)
    try {
      const read = await readCall(spool(call, join(folder, CALL)))
      if (read.json.tau === undefined) throw new Error('fleet: the call does not carry its tau')
      // Every blob read, and so the whole call checked, before anything is made of it.
      await placeCall(read, { tau: tauDir })
      const tau = loadTau(tauDir)
      // Where the box places each handle is its own; here, only whether the values fit.
      tau.bind(read.json.values, { cwd: '/' }, ({ name }) => `/${name}`)
      return { tauRoot: await realpath(tau.dir), linked: linkApis(tau, this.exts) }
    } catch (error) {
      // The tau as the caller has it.
      throw new Error((error as Error).message.replaceAll(tauDir, about.tauDir), { cause: error })
    }
  }

  private async setUp(sessionId: string, { tauRoot, linked }: Accepted, about: About, project: string, caller: Caller): Promise<Started> {
    const box = await this.docker.create(`fleet-tau-${sessionId.slice('session-'.length)}`)
    let setup: Setup
    try {
      await box.start()
      const report = new Report()
      await box.pipe([HELPER_NODE, TAU_ENTRY, 'setup'], { input: createReadStream(join(this.registry.folder(sessionId), CALL)), output: report })
      setup = report.setup()
      for (const api of linked.apis) await box.copyIn(api.client, posix.join(setup.clients, api.name))
      await box.request('apis.link', {
        modules: setup.modules,
        apis: linked.apis.map(({ name }) => ({ name, client: posix.join(setup.clients, name), types: posix.join(setup.self, 'api', name) })),
        packages: linked.packages.map(({ name, dir }) => ({ name, dir: posix.join(setup.self, ...relative(tauRoot, dir).split(sep)) })),
      })
      await box.stop()
      this.taus.set(sessionId, { project, cwd: setup.cwd })
      await this.registry.put({
        sessionId,
        caller,
        box: box.container,
        tauDir: about.tauDir,
        project,
        prompt: setup.prompt,
        promptRequestId: randomUUID(),
        handles: setup.handles,
        targets: about.targets,
        cwd: setup.cwd,
        modules: setup.modules,
        apis: linked.apis.map(api => api.name),
        exposed: linked.exposed,
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      this.taus.delete(sessionId)
      await box.remove().catch(() => {})
      throw error
    }
    this.boxes.set(sessionId, Promise.resolve(box))
    this.log(`created ${sessionId} in box ${box.container}, with the prompt:\n${setup.prompt.trimEnd()}`)
    return { sessionId, box: box.container, prompt: setup.prompt }
  }

  /** The project a caller's run is in: `fleet`'s folder, through symlinks, or a tau's session's own project. */
  private async projectFor(caller: Caller, about: About): Promise<string> {
    if (caller.kind === 'session') {
      const project = this.taus.get(caller.sessionId)?.project
      if (project === undefined) throw new Error(`fleet: ${caller.sessionId} is not a tau's session, so it starts no runs from a box`)
      return project
    }
    if (about.project === undefined || !posix.isAbsolute(about.project)) throw new Error('fleet: a run from the host names its project, an absolute path')
    return await realpath(about.project)
  }

  /** A session's registry entry; a session that is not a tau's fails. */
  entry(sessionId: string): Promise<Entry> {
    return this.registry.get(sessionId)
  }

  /** The registry entry of every session, oldest first. */
  async list(): Promise<Entry[]> {
    const entries = await Promise.all((await this.registry.list()).map(sessionId => this.registry.find(sessionId)))
    return entries.filter(entry => entry !== undefined).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Record that a session was given its prompt. */
  async prompted(sessionId: string): Promise<void> {
    await this.registry.put({ ...await this.registry.get(sessionId), promptedAt: new Date().toISOString() })
  }

  /** Record that a session's run ended, and how. */
  async ended(sessionId: string, result: Result): Promise<void> {
    await this.registry.put({ ...await this.registry.get(sessionId), ended: { at: new Date().toISOString(), result } })
  }

  /**
   * Keep the result of a session's run, which ended as `outcome` says, in
   * the session's folder: for a run that succeeded, as its box packs it from
   * what the agent left at the places of its `$out` and `$inout` handles
   * (fleet-image/tau/endpoint), failing the run when that does not fit the
   * tau. The result is read again here, and checked against the run, since
   * the box is the agent's: one that does not fit fails the run too. A run
   * that failed gives back nothing.
   * @returns how the run ended, as its result has it.
   */
  async pack(sessionId: string, outcome: Result): Promise<Result> {
    return await this.serial(sessionId, async () => {
      const { handles } = await this.registry.get(sessionId)
      const folder = this.registry.folder(sessionId)
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const file = join(folder, RESULT)
      let ended = outcome
      if (ended.ok) {
        try {
          const box = await this.running(sessionId)
          await box.pipe([HELPER_NODE, TAU_ENTRY, 'pack', JSON.stringify({ outcome })], { output: createWriteStream(file, { mode: 0o600 }) })
          const { json, blobs } = await readResult(createReadStream(file))
          if (json.text !== outcome.text) throw new Error('its text is not the agent\'s')
          checkResult(json, handles)
          for await (const blob of blobs) for await (const _ of blob.entries);
          return json.failure === undefined ? { ok: json.ok, text: json.text } : { ok: json.ok, text: json.text, failure: json.failure }
        } catch (error) {
          ended = { ok: false, text: outcome.text, failure: `could not get back what the run gave: ${error instanceof Error ? error.message : String(error)}` }
        }
      }
      await pipeline(Readable.from(writeResult({ ...ended, outputs: {} }, [])), createWriteStream(file, { mode: 0o600 }))
      return ended
    })
  }

  /**
   * The result of a session's run that ended, as {@link pack} kept it: tau's
   * archive of how it ended and what it gave back.
   */
  async result(sessionId: string): Promise<AsyncIterable<Uint8Array>> {
    const file = await open(join(this.registry.folder(sessionId), RESULT))
    return file.createReadStream()
  }

  /** Record that a `finish` first gave back how a session's run ended; its result stays, for the next. */
  async finished(sessionId: string): Promise<void> {
    await this.registry.put({ ...await this.registry.get(sessionId), finishedAt: new Date().toISOString() })
  }

  /** Whether a session is a tau's, at once, so that a caller that cannot wait, such as a process's start, can ask. */
  isTau(sessionId: string): boolean {
    return this.taus.has(sessionId)
  }

  /**
   * Where a path of a tau's session's work is in its box. dsh runs the
   * session's work in its project, the caller's folder, which is the
   * working directory the box's runtime reported, /tau/workspace, in the
   * box; a path in the project is there too, and any other path is as it
   * is. A session that is not a tau's keeps its paths.
   */
  boxPath(sessionId: string, path: string): string {
    const tau = this.taus.get(sessionId)
    if (tau === undefined) return path
    if (path === tau.project) return tau.cwd
    return path.startsWith(`${tau.project}/`) ? `${tau.cwd}${path.slice(tau.project.length)}` : path
  }

  /**
   * The started box of a tau's session, for its files and processes
   * (../world/), started if it is not, as after a restart or a stop; or
   * undefined for a session that is not a tau's.
   */
  async boxFor(sessionId: string): Promise<RunBox | undefined> {
    if (!this.taus.has(sessionId)) return undefined
    return this.serial(sessionId, async () => this.taus.has(sessionId) ? this.running(sessionId) : undefined)
  }

  /**
   * Copy a host file into the box of a tau's session, at `to`, readable by
   * all and writable by none, once: asked again for the same place, it does
   * nothing, unless the copy failed, which it prints. It answers at once, and
   * copies in turn with the session's other operations on its box, so a
   * {@link boxFor} asked after it waits for the copy. A session that is not a
   * tau's is ignored.
   * @param from - the host file, absolute.
   * @param to - its place in the box, absolute.
   */
  copyInOnce(sessionId: string, from: string, to: string): void {
    if (!this.taus.has(sessionId)) return
    let copies = this.copies.get(sessionId)
    if (copies === undefined) this.copies.set(sessionId, copies = new Map())
    if (copies.has(to)) return
    const copying = this.serial(sessionId, async () => {
      if (!this.taus.has(sessionId)) return
      const box = await this.running(sessionId)
      await exec(box, ['mkdir', '-p', posix.dirname(to)])
      await box.copyIn(from, to)
      await exec(box, ['chmod', 'a=r', to])
    })
    copies.set(to, copying)
    copying.catch((error: unknown) => {
      if (this.copies.get(sessionId)?.get(to) === copying) this.copies.get(sessionId)?.delete(to)
      this.log(`could not copy ${from} into the box of ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Start a session's box, and a new helper in it; a session that is not a tau's fails. */
  async start(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      await (await this.box(sessionId)).start(this.calls(sessionId))
      this.started.add(sessionId)
    })
  }

  /** Stop a session's box, which keeps what is in it. */
  async stop(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      await (await this.box(sessionId)).stop()
      this.started.delete(sessionId)
    })
  }

  /**
   * Remove a session's box, running or not, its registry entry and its
   * folder. A box removed by other means leaves only the entry.
   */
  async remove(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      const entry = await this.registry.get(sessionId)
      try {
        await (await this.box(sessionId)).remove()
      } catch (error) {
        if (await this.docker.exists(entry.box)) throw error
      }
      this.boxes.delete(sessionId)
      this.started.delete(sessionId)
      this.copies.delete(sessionId)
      await rm(this.registry.folder(sessionId), { recursive: true, force: true })
      await this.registry.delete(sessionId)
      this.taus.delete(sessionId)
    })
  }

  /** Stop the boxes started here. */
  async close(): Promise<void> {
    const started = [...this.started]
    this.started.clear()
    await Promise.all(started.map(async (sessionId) => {
      try {
        await (await this.box(sessionId)).stop()
      } catch (error) {
        this.log(`could not stop the box of ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))
  }

  /**
   * What answers the calls of the clients in a session's box: the server of
   * the extension that implements the API, for an API the session's tau
   * declares, with the session the box is, whatever the call says.
   */
  private calls(sessionId: string): (call: Call, signal: AbortSignal) => Promise<unknown> {
    return async ({ api, method, args }, signal) => {
      const entry = await this.registry.get(sessionId)
      if (!entry.apis.includes(api)) throw new Error(`fleet: this run's tau declares no API ${api}`)
      const ext = this.exts.get(api)
      if (ext === undefined) throw new Error(`fleet: no extension implements ${api} now`)
      if (!Object.hasOwn(ext.methods, method)) throw new Error(`fleet: the extension of ${api} has no method ${method}`)
      return await ext.methods[method]?.(args, { sessionId, signal })
    }
  }

  /** Run a session's operations on its box one after another. */
  private serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(sessionId) ?? Promise.resolve()).then(operation)
    const settled = next.then(() => {}, () => {})
    this.queues.set(sessionId, settled)
    void settled.then(() => { if (this.queues.get(sessionId) === settled) this.queues.delete(sessionId) })
    return next
  }

  /** A session's box, started if it was not started here, in one of its operations. */
  private async running(sessionId: string): Promise<RunBox> {
    const box = await this.box(sessionId)
    if (!this.started.has(sessionId)) {
      await box.start(this.calls(sessionId))
      this.started.add(sessionId)
    }
    return box
  }

  /** A session's box, opened the first time it is asked for. */
  private box(sessionId: string): Promise<RunBox> {
    const known = this.boxes.get(sessionId)
    if (known !== undefined) return known
    const opening = this.registry.get(sessionId).then(entry => this.docker.open(entry.box))
    this.boxes.set(sessionId, opening)
    // One that would not open is opened again the next time.
    opening.catch(() => { if (this.boxes.get(sessionId) === opening) this.boxes.delete(sessionId) })
    return opening
  }
}

/** `bytes`, as they are read, written to `file` too, which is whole once they are all read. */
async function* spool(bytes: AsyncIterable<Uint8Array>, file: string): AsyncGenerator<Uint8Array> {
  const out = createWriteStream(file, { mode: 0o600 })
  try {
    for await (const chunk of bytes) {
      if (!out.write(chunk)) await once(out, 'drain')
      yield chunk
    }
  } finally {
    out.end()
    await finished(out)
  }
}

/**
 * What the box's runtime reports of a run it set up (fleet-image/tau/endpoint).
 * It runs before the agent does, on the call the host checked, so it is
 * taken as it is, once it has the shape of one.
 */
class Report extends Writable {
  private readonly chunks: Buffer[] = []

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.chunks.push(chunk)
    done()
  }

  setup(): Setup {
    const text = Buffer.concat(this.chunks).toString('utf8')
    let setup: Partial<Setup>
    try {
      setup = JSON.parse(text) as Partial<Setup>
    } catch {
      throw new Error(`fleet: the box's runtime reported something else than JSON: ${text.slice(0, 200)}`)
    }
    const paths = [setup.cwd, setup.modules, setup.self, setup.clients]
    if (typeof setup.prompt !== 'string' || !Array.isArray(setup.handles) || !paths.every(path => typeof path === 'string' && posix.isAbsolute(path))) {
      throw new Error('fleet: the box\'s runtime reported no setup')
    }
    return setup as Setup
  }
}
