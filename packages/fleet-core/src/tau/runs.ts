/**
 * The runs of taus, and their boxes (docs/fleet-core/tau/index.md), the
 * backend of tau's fleet adaptor: a run's call, tau's archive of the run's
 * envelope with the content of its files, and the tau (tau's
 * docs/spec/serialization.md), is admitted against the extensions provided
 * (./admission.ts) and kept in the session's folder; a box is made for it,
 * which the box's runtime sets up from the call (./box-setup.ts); the
 * session is registered (./registry.ts); and its box is kept (./session-box.ts),
 * started, stopped, removed and set up again, with the tau's init run in
 * it, and the calls its clients make answered with the extensions' servers
 * (./calls.ts). Once the run ended, its box packs its result, which is kept,
 * checked. It never learns a caller's paths: the caller's adaptor packs the
 * call, and puts the result at them. It uses nothing of dsh's, so both
 * fleet-core's world (../world/), which serves a tau's session from its box,
 * through {@link TauBoxes}, and the tau service (./service.ts), which makes
 * the session, through {@link RunLifecycle}, build on it.
 * @module @sleepymug/fleet-core/tau/runs
 */

import { createReadStream } from 'node:fs'
import { mkdir, open, realpath, rm } from 'node:fs/promises'
import { posix } from 'node:path'
import type { Result } from '@sleepymug/fleet-protocol/tau'
import type { Platform } from '../platform.ts'
import { messageOf } from '../util/error.ts'
import { spool } from '../util/stream.ts'
import { admit, type Accepted } from './admission.ts'
import { catalogOf, type Exts } from './apis.ts'
import { furnish, packIn, placed } from './box-setup.ts'
import { callsOf } from './calls.ts'
import type { About, Held, InitEnd, Occupant, RunBox, RunLifecycle, Started, TauBoxes } from './ports.ts'
import { HOST, type Caller, type Entry, type Registry } from './registry.ts'
import { type Boxes, dockerBoxes, SessionBox } from './session-box.ts'

/** How long a run's init, cancelled, has after SIGTERM before SIGKILL. */
const INIT_GRACE_MS = 5_000

/** What the runs are built on. */
export interface TauRunsDeps {
  registry: Registry
  /** The extensions provided, which link a run's APIs and answer its clients' calls. */
  exts: Exts
  platform: Platform
  /** Docker's, by default. */
  boxes?: Boxes
  /** How long a box nothing occupies runs before it is stopped; 60 s by default. */
  idleStopMs?: number
}

/** A tau's session, as the runs know it at once. */
interface Run {
  /** The dsh workspace the session is in. */
  project: string
  /** The agent's working directory in the box, as the box's runtime reported it. */
  cwd: string
  box: SessionBox
}

export class TauRuns implements TauBoxes, RunLifecycle {
  /**
   * The sessions with a registry entry, as {@link load} found them and as
   * they were made and removed since.
   */
  private readonly runs = new Map<string, Run>()
  private readonly registry: Registry
  private readonly exts: Exts
  private readonly platform: Platform
  private readonly boxes: Boxes
  private readonly idleStopMs: number

  constructor({ registry, exts, platform, boxes = dockerBoxes, idleStopMs = 60_000 }: TauRunsDeps) {
    this.registry = registry
    this.exts = exts
    this.platform = platform
    this.boxes = boxes
    this.idleStopMs = idleStopMs
  }

  /** Find the sessions the registry has, before anyone asks which sessions are a tau's. */
  async load(): Promise<void> {
    for (const sessionId of await this.registry.list()) {
      const { project, cwd, box } = await this.registry.get(sessionId)
      this.runs.set(sessionId, { project, cwd, box: this.sessionBox(sessionId, box) })
    }
  }

  /**
   * Set up a box for a run of a call, and leave it stopped. First the call
   * is admitted as it comes, and kept in the session's folder. Then the box
   * is created and started, and its runtime sets it up from the call, and
   * reports the prompt, the files and where things are; the APIs are linked;
   * and the session is registered. A failure removes the box and the
   * session's folder.
   * @param call - tau's archive of the call, which carries the tau.
   * @param caller - the host's `tau` command, or a session: a tau's, from its box, whose runs are in its project, or another, with `tau_run`.
   */
  async create(call: AsyncIterable<Uint8Array>, about: About, caller: Caller = HOST): Promise<Started> {
    const sessionId = `session-${this.platform.newId()}`
    const project = await this.projectFor(caller, about)
    const files = this.registry.files(sessionId)
    await mkdir(files.folder, { recursive: true, mode: 0o700 })
    try {
      const accepted = await admit(spool(call, files.call), { catalog: catalogOf(this.exts), scratch: files.tau, title: about.title })
      return await this.setUp(sessionId, accepted, about, project, caller)
    } catch (error) {
      await rm(files.folder, { recursive: true, force: true })
      throw error
    }
  }

  private async setUp(sessionId: string, accepted: Accepted, about: About, project: string, caller: Caller): Promise<Started> {
    const box = await this.boxes.create(`fleet-tau-${sessionId.slice('session-'.length)}`)
    let setup
    try {
      await box.start()
      setup = await furnish(box, this.registry.files(sessionId).call, accepted)
      await box.stop()
      await this.registry.put({
        sessionId,
        caller,
        box: box.container,
        title: about.title,
        project,
        prompt: setup.prompt,
        ...setup.init === undefined ? {} : { init: { command: setup.init, dir: setup.cwd } },
        promptRequestId: this.platform.newId(),
        files: placed(accepted, setup),
        cwd: setup.cwd,
        modules: setup.modules,
        apis: accepted.links.map(link => link.contract),
        exposed: accepted.exposed,
        skills: accepted.skills,
        createdAt: this.platform.now().toISOString(),
      })
    } catch (error) {
      await box.remove().catch(() => {})
      throw error
    }
    this.runs.set(sessionId, { project, cwd: setup.cwd, box: this.sessionBox(sessionId, box.container, box) })
    this.platform.log(`created ${sessionId} in box ${box.container}, with the prompt:\n${setup.prompt.trimEnd()}`)
    return { sessionId, box: box.container, prompt: setup.prompt }
  }

  /**
   * Set a session's box up again from the run's call, which is kept, with
   * the APIs linked to the extensions provided now, and leave it started;
   * what the agent did in the box before is gone. The entry records when,
   * so the agent is told once (./reset.ts).
   */
  private async rebuild(sessionId: string): Promise<RunBox> {
    const entry = await this.registry.get(sessionId)
    const files = this.registry.files(sessionId)
    let box: RunBox | undefined
    try {
      const accepted = await admit(createReadStream(files.call), { catalog: catalogOf(this.exts), scratch: files.tau, title: entry.title })
      box = await this.boxes.create(entry.box)
      await box.start(this.callsOf(sessionId))
      const setup = await furnish(box, files.call, accepted)
      await this.registry.put({
        ...entry,
        files: placed(accepted, setup),
        cwd: setup.cwd,
        modules: setup.modules,
        apis: accepted.links.map(link => link.contract),
        exposed: accepted.exposed,
        skills: accepted.skills,
        resetAt: this.platform.now().toISOString(),
      })
      const run = this.runs.get(sessionId)
      if (run !== undefined) run.cwd = setup.cwd
      this.platform.log(`set up the box ${entry.box} of ${sessionId} again, from its call`)
      return box
    } catch (error) {
      await box?.remove().catch(() => {})
      throw new Error(`fleet: could not set up the box of ${sessionId} again: ${messageOf(error)}`, { cause: error })
    }
  }

  /**
   * The project a caller's run is in: a tau's session's own project, or
   * else the folder the caller names, through symlinks: the host's `tau`
   * command's, or the working directory of a session that is no tau's.
   */
  private async projectFor(caller: Caller, about: About): Promise<string> {
    const own = caller.kind === 'session' ? this.runs.get(caller.sessionId)?.project : undefined
    if (own !== undefined) return own
    if (about.project === undefined || !posix.isAbsolute(about.project)) throw new Error('fleet: a run from outside a box names its project, an absolute path')
    return await realpath(about.project)
  }

  entry(sessionId: string): Promise<Entry> {
    return this.registry.get(sessionId)
  }

  list(): Promise<Entry[]> {
    return this.registry.entries()
  }

  /**
   * Run a session's init, its tau's command, with `sh -c` in the agent's
   * working directory in its box, which it occupies until the command ends,
   * and collect what it writes; the signal ends the command's process group.
   * A session whose tau has no init fails.
   */
  async init(sessionId: string, signal: AbortSignal): Promise<InitEnd> {
    const { init } = await this.registry.get(sessionId)
    if (init === undefined) throw new Error(`fleet: the tau of ${sessionId} has no init`)
    const process = this.platform.newId()
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

  async prompted(sessionId: string): Promise<void> {
    await this.registry.update(sessionId, { promptedAt: this.platform.now().toISOString() })
  }

  async ended(sessionId: string, result: Result): Promise<void> {
    await this.registry.update(sessionId, { ended: { at: this.platform.now().toISOString(), result } })
  }

  /**
   * Keep the result of a session's run, which ended as `outcome` says, in
   * the session's folder: for a run that succeeded, as its box packs it from
   * what the agent left at the places of its `out` and `inout` files,
   * checked against the run (./box-setup.ts); a run that failed gives back
   * nothing.
   * @returns how the run ended, as its result has it.
   */
  async pack(sessionId: string, outcome: Result): Promise<Result> {
    return await this.run(sessionId).box.exclusive(async (running) => {
      const { files } = await this.registry.get(sessionId)
      const kept = this.registry.files(sessionId)
      await mkdir(kept.folder, { recursive: true, mode: 0o700 })
      return await packIn(running, outcome, files, kept.result)
    })
  }

  /** The result of a session's run that ended, as {@link pack} kept it: tau's archive of how it ended and what it gave back. */
  async result(sessionId: string): Promise<AsyncIterable<Uint8Array>> {
    const file = await open(this.registry.files(sessionId).result)
    return file.createReadStream()
  }

  /** Record that a `finish` first gave back how a session's run ended; its result stays, for the next. */
  async finished(sessionId: string): Promise<void> {
    await this.registry.update(sessionId, { finishedAt: this.platform.now().toISOString() })
  }

  /** Record that a session's run was released, its session and box kept, as its own entry, folder and result are. */
  async released(sessionId: string): Promise<void> {
    await this.registry.update(sessionId, { releasedAt: this.platform.now().toISOString() })
  }

  isTau(sessionId: string): boolean {
    return this.runs.has(sessionId)
  }

  /**
   * dsh runs a tau's session's work in its project, the caller's folder,
   * which is the working directory the box's runtime reported, in the box.
   */
  boxPath(sessionId: string, path: string): string {
    const run = this.runs.get(sessionId)
    if (run === undefined) return path
    if (path === run.project) return run.cwd
    return path.startsWith(`${run.project}/`) ? `${run.cwd}${path.slice(run.project.length)}` : path
  }

  async boxFor(sessionId: string): Promise<RunBox | undefined> {
    // Released at once: a box nothing occupies afterwards is stopped once it has been idle long enough.
    const held = await this.hold(sessionId, { kind: 'call', id: 'boxFor' })
    held?.release()
    return held?.box
  }

  async hold(sessionId: string, occupant: Occupant): Promise<Held | undefined> {
    return await this.runs.get(sessionId)?.box.hold(occupant)
  }

  occupy(sessionId: string, occupant: Occupant): () => void {
    return this.runs.get(sessionId)?.box.occupy(occupant) ?? (() => {})
  }

  isStarted(sessionId: string): boolean {
    return this.runs.get(sessionId)?.box.isStarted() ?? false
  }

  /** What occupies a session's box now. */
  occupied(sessionId: string): Occupant[] {
    return this.runs.get(sessionId)?.box.occupied() ?? []
  }

  async stopWhenVacant(sessionId: string): Promise<void> {
    await this.runs.get(sessionId)?.box.stopWhenVacant()
  }

  async whenStarted(sessionId: string, signal: AbortSignal): Promise<RunBox> {
    return await this.run(sessionId).box.whenStarted(signal)
  }

  copyInOnce(sessionId: string, from: string, to: string): void {
    this.runs.get(sessionId)?.box.copyInOnce(from, to)
  }

  /** Start a session's box, and a new helper in it; a session that is not a tau's fails. */
  async start(sessionId: string): Promise<void> {
    await this.run(sessionId).box.start()
  }

  /** Stop a session's box, which keeps what is in it. */
  async stop(sessionId: string): Promise<void> {
    await this.run(sessionId).box.stop()
  }

  /**
   * Remove a session's box, running or not, while the session is archived:
   * its registry entry and its folder stay, so the run's result does, and
   * {@link boxFor} fails until {@link unarchive}, after which it sets the box
   * up again. A box that is gone is let be.
   */
  async archive(sessionId: string): Promise<void> {
    await this.runs.get(sessionId)?.box.archive()
  }

  unarchive(sessionId: string): void {
    this.runs.get(sessionId)?.box.unarchive()
  }

  isArchived(sessionId: string): boolean {
    return this.runs.get(sessionId)?.box.isArchived() ?? false
  }

  /**
   * Remove a session's box, running or not, its registry entry and its
   * folder. A box removed by other means leaves only the entry.
   */
  async remove(sessionId: string): Promise<void> {
    await this.run(sessionId).box.remove(async () => {
      await this.registry.delete(sessionId)
      this.runs.delete(sessionId)
    })
  }

  /** Stop the boxes started here. */
  async close(): Promise<void> {
    await Promise.all([...this.runs.values()].map(run => run.box.close()))
  }

  /** A tau's session; another fails. */
  private run(sessionId: string): Run {
    const run = this.runs.get(sessionId)
    if (run === undefined) throw new Error(`fleet: no tau session ${sessionId}`)
    return run
  }

  private sessionBox(sessionId: string, container: string, box?: RunBox): SessionBox {
    return new SessionBox({
      sessionId,
      container,
      boxes: this.boxes,
      platform: this.platform,
      idleStopMs: this.idleStopMs,
      calls: this.callsOf(sessionId),
      rebuild: () => this.rebuild(sessionId),
    }, box)
  }

  /** What answers the calls of the clients in a session's box, by the APIs its tau holds now. */
  private callsOf(sessionId: string): ReturnType<typeof callsOf> {
    return callsOf(this.exts, sessionId, async () => (await this.registry.get(sessionId)).apis)
  }
}
