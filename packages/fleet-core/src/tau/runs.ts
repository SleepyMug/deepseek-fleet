/**
 * The runs of taus, and their boxes (docs/fleet-core/tau/index.md): it
 * checks a run's call, tau's archive of the run's values with the content of
 * its handles, and the tau (tau's docs/spec/serialization.md), keeps it, and
 * has a box's runtime set the box up from it (fleet-box-runtime/tau/endpoint),
 * which places everything where the box has things, with the tau's APIs
 * linked to the clients of the extensions that implement them (./apis.ts); keeps which box each session has (./registry.ts); starts,
 * stops and removes the box, runs the tau's init in it (./init.ts), and
 * copies host files into it as they are asked for; keeps the run's result, the archive of what it gave back, which its
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
import type { Call } from 'fleet-box-runtime/helper/protocol'
import { HELPER_NODE, TAU_ENTRY } from 'fleet-box-runtime/layout'
import type { Setup } from 'fleet-box-runtime/tau/endpoint'
import type { Result, Started, Targets } from 'fleet-protocol/tau'
import { Box, exec } from '../box/box.ts'
import { linkApis, type Exts, type Linked } from './apis.ts'
import type { Caller, Entry, Registry } from './registry.ts'

/** What a run's box is used for. */
export type RunBox = Pick<Box, 'container' | 'start' | 'stop' | 'remove' | 'copyIn' | 'pipe' | 'request'>

/** Something that needs a session's box running now. */
export interface Occupant {
  /**
   * `turn`: the session's agent is running.
   * `terminal`: a user's shell, until it ends.
   * `process`: a process in the box, until it exits.
   * `call`: a request to the box's helper for a caller, while it runs.
   * `file`: a file call served from the box, while it runs.
   */
  kind: 'turn' | 'terminal' | 'process' | 'call' | 'file'
  /** The agent's, terminal's, process's or call's own id. */
  id: string
}

/** What a call says of itself, besides the archive. */
export interface About {
  /** What names the run, in `list` and dsh's web UI. */
  title: string
  /** The caller's folder, absolute, unless it is a tau's session, whose runs are in its own project. */
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
  /** The tau's init, its command, if it has one. */
  init: string | undefined
}

/** How a run's init ended (./init.ts). */
export interface InitEnd {
  /** Its exit code, or null when a signal killed it. */
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

/** How long a run's init, cancelled, has after SIGTERM before SIGKILL. */
const INIT_GRACE_MS = 5_000

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
  /** The sessions whose box is removed while they are archived. */
  private readonly archived = new Set<string>()
  /** What occupies each session's box, which is not stopped for being idle while anything does. */
  private readonly occupants = new Map<string, Map<symbol, Occupant>>()
  /** Each session's pending stop of its idle box, which every vacancy arms again. */
  private readonly idle = new Map<string, NodeJS.Timeout>()
  /** The sessions whose box stops as soon as nothing occupies it, as after their run ended. */
  private readonly soon = new Set<string>()
  /** What waits for each session's box to be started, to wake as it is. */
  private readonly waiters = new Map<string, Set<() => void>>()

  constructor(
    private readonly registry: Registry,
    private readonly exts: Exts,
    private readonly log: (message: string) => void,
    private readonly docker: Boxes = dockerBoxes,
    /** How long a box nothing occupies runs before it is stopped. */
    private readonly idleStopMs = 60_000,
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
   * (fleet-box-runtime/tau/endpoint), placing it all where it has things, and
   * reports the prompt, the handles and where things are; each API's client
   * is copied in, where the runtime says, and the APIs and what the tau
   * exposes linked; and the session is registered. A failure removes the box
   * and the session's folder.
   * @param call - tau's archive of the call, which carries the tau.
   * @param caller - `fleet`, on the host, or a session: a tau's, from its box, whose runs are in its project, or another, with `tau_run`.
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
      return { tauRoot: await realpath(tau.dir), linked: linkApis(tau, this.exts), init: tau.init }
    } catch (error) {
      // The tau as the caller names it.
      throw new Error((error as Error).message.replaceAll(tauDir, `the tau ${about.title}`), { cause: error })
    }
  }

  /** Read a kept call's tau again, in the session's folder, and link its APIs to the extensions provided now. */
  private async reread(sessionId: string, title: string): Promise<Accepted> {
    const folder = this.registry.folder(sessionId)
    const tauDir = join(folder, TAU)
    try {
      await placeCall(await readCall(createReadStream(join(folder, CALL))), { tau: tauDir })
      const tau = loadTau(tauDir)
      return { tauRoot: await realpath(tau.dir), linked: linkApis(tau, this.exts), init: tau.init }
    } catch (error) {
      throw new Error((error as Error).message.replaceAll(tauDir, `the tau ${title}`), { cause: error })
    }
  }

  /**
   * Have a started box's runtime set it up from the session's call, copy
   * each API's client in, where the runtime says, and link the APIs and what
   * the tau exposes.
   * @returns what the runtime reported.
   */
  private async furnish(box: RunBox, sessionId: string, { tauRoot, linked }: Accepted): Promise<Setup> {
    const report = new Report()
    await box.pipe([HELPER_NODE, TAU_ENTRY, 'setup'], { input: createReadStream(join(this.registry.folder(sessionId), CALL)), output: report })
    const setup = report.setup()
    for (const api of linked.apis) await box.copyIn(api.client, posix.join(setup.clients, api.name))
    await box.request('apis.link', {
      modules: setup.modules,
      apis: linked.apis.map(({ name }) => ({ name, client: posix.join(setup.clients, name), types: posix.join(setup.self, 'api', name) })),
      packages: linked.packages.map(({ name, dir }) => ({ name, dir: posix.join(setup.self, ...relative(tauRoot, dir).split(sep)) })),
    })
    return setup
  }

  private async setUp(sessionId: string, accepted: Accepted, about: About, project: string, caller: Caller): Promise<Started> {
    const { linked, init } = accepted
    const box = await this.docker.create(`fleet-tau-${sessionId.slice('session-'.length)}`)
    let setup: Setup
    try {
      await box.start()
      setup = await this.furnish(box, sessionId, accepted)
      await box.stop()
      this.taus.set(sessionId, { project, cwd: setup.cwd })
      await this.registry.put({
        sessionId,
        caller,
        box: box.container,
        title: about.title,
        project,
        prompt: setup.prompt,
        ...init === undefined ? {} : { init: { command: init, dir: setup.self } },
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

  /**
   * The project a caller's run is in: a tau's session's own project, or
   * else the folder the caller names, through symlinks: `fleet`'s, or the
   * working directory of a session that is no tau's.
   */
  private async projectFor(caller: Caller, about: About): Promise<string> {
    const own = caller.kind === 'session' ? this.taus.get(caller.sessionId)?.project : undefined
    if (own !== undefined) return own
    if (about.project === undefined || !posix.isAbsolute(about.project)) throw new Error('fleet: a run from outside a box names its project, an absolute path')
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

  /**
   * Run a session's init, its tau's command, with `sh -c` in the tau's own
   * directory in its box, which it occupies until the command ends, and
   * collect what it writes; the signal ends the command's process group.
   * A session whose tau has no init fails.
   */
  async init(sessionId: string, signal: AbortSignal): Promise<InitEnd> {
    const { init } = await this.registry.get(sessionId)
    if (init === undefined) throw new Error(`fleet: the tau of ${sessionId} has no init`)
    const process = randomUUID()
    const held = await this.hold(sessionId, { kind: 'process', id: process })
    if (held === undefined) throw new Error(`fleet: no tau session ${sessionId}`)
    const { box, release } = held
    const kill = (): void => { void box.request('kill', { process }).catch(() => {}) }
    signal.addEventListener('abort', kill, { once: true })
    try {
      signal.throwIfAborted()
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const { code, signal: killed } = await box.request('spawn', {
        process, argv: ['sh', '-c', init.command], cwd: init.dir, env: {}, stdin: null, graceMs: INIT_GRACE_MS,
      }, (event) => { (event.stream === 'stdout' ? stdout : stderr).push(Buffer.from(event.data, 'base64')) })
      return { code, signal: killed, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
    } finally {
      signal.removeEventListener('abort', kill)
      release()
    }
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
   * (fleet-box-runtime/tau/endpoint), failing the run when that does not fit
   * the tau. The result is read again here, and checked against the run,
   * since the box is the agent's: one that does not fit fails the run too. A
   * run that failed gives back nothing.
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
   * (../world/), started if it is not, as after a restart or a stop, and set
   * up again from the run's call if it is gone, as after an archive; or
   * undefined for a session that is not a tau's. While the session is
   * archived ({@link archive}), it fails.
   */
  async boxFor(sessionId: string): Promise<RunBox | undefined> {
    // Released at once: a box nothing occupies afterwards is stopped once it has been idle long enough.
    const held = await this.hold(sessionId, { kind: 'call', id: 'boxFor' })
    held?.release()
    return held?.box
  }

  /**
   * The box of a tau's session, as {@link boxFor} gives it, occupied by
   * `occupant` from before it is asked for until the release, so it is not
   * stopped for being idle under it; or undefined, occupying nothing, for a
   * session that is not a tau's.
   */
  async hold(sessionId: string, occupant: Occupant): Promise<{ box: RunBox; release: () => void } | undefined> {
    if (!this.taus.has(sessionId)) return undefined
    const release = this.occupy(sessionId, occupant)
    try {
      const box = await this.serial(sessionId, async () => this.taus.has(sessionId) ? this.running(sessionId) : undefined)
      if (box === undefined) release()
      return box === undefined ? undefined : { box, release }
    } catch (error) {
      release()
      throw error
    }
  }

  /**
   * Occupy a session's box: it is not stopped for being idle until the
   * returned release, which only the first call does, once nothing of the
   * occupant can reach the box. Occupy before asking for the box.
   */
  occupy(sessionId: string, occupant: Occupant): () => void {
    let uses = this.occupants.get(sessionId)
    if (uses === undefined) this.occupants.set(sessionId, uses = new Map())
    const held = uses
    const token = Symbol(occupant.id)
    held.set(token, occupant)
    this.disarm(sessionId)
    return () => {
      if (!held.delete(token)) return
      if (held.size === 0 && this.occupants.get(sessionId) === held) this.occupants.delete(sessionId)
      this.vacated(sessionId)
    }
  }

  /** Whether a session's box is started here, and not stopping. */
  isStarted(sessionId: string): boolean {
    return this.started.has(sessionId)
  }

  /** What occupies a session's box now. */
  occupied(sessionId: string): Occupant[] {
    return [...this.occupants.get(sessionId)?.values() ?? []]
  }

  /**
   * Stop a session's box as soon as nothing occupies it: now, if nothing
   * does, as when its run ended; else once the last occupant leaves.
   */
  async stopWhenVacant(sessionId: string): Promise<void> {
    if (this.occupied(sessionId).length > 0) {
      this.soon.add(sessionId)
      return
    }
    this.disarm(sessionId)
    await this.serial(sessionId, () => this.stopVacant(sessionId, true))
  }

  /**
   * A session's box once it is started, now or whenever something next
   * starts it; this starts nothing. It fails once the session is gone, or
   * the signal aborts.
   */
  async whenStarted(sessionId: string, signal: AbortSignal): Promise<RunBox> {
    for (;;) {
      signal.throwIfAborted()
      if (!this.taus.has(sessionId)) throw new Error(`fleet: no tau session ${sessionId}`)
      if (this.started.has(sessionId)) return await this.box(sessionId)
      const woken = Promise.withResolvers<void>()
      const wake = (): void => { woken.resolve() }
      let waiting = this.waiters.get(sessionId)
      if (waiting === undefined) this.waiters.set(sessionId, waiting = new Set())
      waiting.add(wake)
      signal.addEventListener('abort', wake, { once: true })
      try {
        await woken.promise
      } finally {
        waiting.delete(wake)
        if (waiting.size === 0 && this.waiters.get(sessionId) === waiting) this.waiters.delete(sessionId)
        signal.removeEventListener('abort', wake)
      }
    }
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
      this.wake(sessionId)
    })
  }

  /** Stop a session's box, which keeps what is in it. */
  async stop(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      // Not started from here on, so what its stop ends knows the box is stopping (../world/fs.ts).
      this.started.delete(sessionId)
      await (await this.box(sessionId)).stop()
    })
  }

  /**
   * Remove a session's box, running or not, while the session is archived:
   * its registry entry and its folder stay, so the run's result does, and
   * {@link boxFor} fails until {@link unarchive}, after which it sets the box
   * up again. A box that is gone is let be.
   */
  async archive(sessionId: string): Promise<void> {
    this.archived.add(sessionId)
    await this.serial(sessionId, async () => {
      if (!this.taus.has(sessionId) || !this.archived.has(sessionId)) return
      const entry = await this.registry.get(sessionId)
      if (await this.docker.exists(entry.box)) {
        await (await this.box(sessionId)).remove()
        this.log(`removed the box ${entry.box} of ${sessionId}, which is archived`)
      }
      this.boxes.delete(sessionId)
      this.started.delete(sessionId)
      this.copies.delete(sessionId)
      this.disarm(sessionId)
      this.soon.delete(sessionId)
    })
  }

  /** Let a session that is no longer archived have a box again, set up on its next use. */
  unarchive(sessionId: string): void {
    this.archived.delete(sessionId)
  }

  /** Whether a session's box is removed while it is archived. */
  isArchived(sessionId: string): boolean {
    return this.archived.has(sessionId)
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
      this.archived.delete(sessionId)
      this.occupants.delete(sessionId)
      this.disarm(sessionId)
      this.soon.delete(sessionId)
      this.wake(sessionId)
    })
  }

  /** Stop the boxes started here. */
  async close(): Promise<void> {
    for (const timer of this.idle.values()) clearTimeout(timer)
    this.idle.clear()
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
  private calls(sessionId: string): (call: Call, signal: AbortSignal, body?: AsyncIterable<Uint8Array>) => Promise<unknown> {
    return async ({ api, method, args }, signal, body) => {
      const entry = await this.registry.get(sessionId)
      if (!entry.apis.includes(api)) throw new Error(`fleet: this run's tau declares no API ${api}`)
      const ext = this.exts.get(api)
      if (ext === undefined) throw new Error(`fleet: no extension implements ${api} now`)
      if (!Object.hasOwn(ext.methods, method)) throw new Error(`fleet: the extension of ${api} has no method ${method}`)
      return await ext.methods[method]?.(args, { sessionId, signal, ...body === undefined ? {} : { body } })
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

  /**
   * A session's box, started if it was not started here, and set up again
   * if it is gone, in one of its operations; none while it is archived.
   */
  private async running(sessionId: string): Promise<RunBox> {
    if (this.archived.has(sessionId)) throw new Error(`fleet: ${sessionId} is archived, so it has no box; unarchive it to have one again`)
    if (this.started.has(sessionId)) return await this.box(sessionId)
    const entry = await this.registry.get(sessionId)
    if (!await this.docker.exists(entry.box)) return await this.rebuild(entry)
    const box = await this.box(sessionId)
    await box.start(this.calls(sessionId))
    this.started.add(sessionId)
    this.wake(sessionId)
    return box
  }

  /** A session's box may have lost its last occupant: stop it once it has been idle long enough, or at once if asked to. */
  private vacated(sessionId: string): void {
    if (this.occupied(sessionId).length > 0) return
    this.disarm(sessionId)
    const timer = setTimeout(() => {
      if (this.idle.get(sessionId) === timer) this.idle.delete(sessionId)
      this.serial(sessionId, () => this.stopVacant(sessionId, false)).catch((error: unknown) => {
        this.log(`could not stop the idle box of ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, this.soon.has(sessionId) ? 0 : this.idleStopMs)
    timer.unref()
    this.idle.set(sessionId, timer)
  }

  /**
   * Stop a session's box, in one of its operations, if nothing occupies it:
   * one started here, or, with `any`, one started by anyone, as by a dsh
   * that stopped before its run ended.
   */
  private async stopVacant(sessionId: string, any: boolean): Promise<void> {
    if (!this.taus.has(sessionId) || this.archived.has(sessionId) || this.occupied(sessionId).length > 0) return
    if (!any && !this.started.has(sessionId)) return
    this.soon.delete(sessionId)
    this.started.delete(sessionId)
    await (await this.box(sessionId)).stop()
  }

  /** Cancel a session's pending idle stop. */
  private disarm(sessionId: string): void {
    clearTimeout(this.idle.get(sessionId))
    this.idle.delete(sessionId)
  }

  /** Wake what waits for a session's box to be started, or for the session to go. */
  private wake(sessionId: string): void {
    for (const resolve of this.waiters.get(sessionId) ?? []) resolve()
  }

  /**
   * Set a session's box up again, in one of its operations, from the run's
   * call, which is kept, with the APIs linked to the extensions provided
   * now, and leave it started; what the agent did in the box before is gone.
   * The entry records when, so the agent is told once (./reset.ts).
   */
  private async rebuild(entry: Entry): Promise<RunBox> {
    const { sessionId } = entry
    this.boxes.delete(sessionId)
    let box: RunBox | undefined
    try {
      const accepted = await this.reread(sessionId, entry.title)
      box = await this.docker.create(entry.box)
      await box.start(this.calls(sessionId))
      const setup = await this.furnish(box, sessionId, accepted)
      const { linked } = accepted
      await this.registry.put({
        ...entry,
        handles: setup.handles,
        cwd: setup.cwd,
        modules: setup.modules,
        apis: linked.apis.map(api => api.name),
        exposed: linked.exposed,
        resetAt: new Date().toISOString(),
      })
      this.taus.set(sessionId, { project: entry.project, cwd: setup.cwd })
      this.boxes.set(sessionId, Promise.resolve(box))
      this.started.add(sessionId)
      this.wake(sessionId)
      this.log(`set up the box ${entry.box} of ${sessionId} again, from its call`)
      return box
    } catch (error) {
      await box?.remove().catch(() => {})
      throw new Error(`fleet: could not set up the box of ${sessionId} again: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    } finally {
      await rm(join(this.registry.folder(sessionId), TAU), { recursive: true, force: true })
    }
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
 * What the box's runtime reports of a run it set up
 * (fleet-box-runtime/tau/endpoint). It runs before the agent does, on the
 * call the host checked, so it is taken as it is, once it has the shape of
 * one.
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
