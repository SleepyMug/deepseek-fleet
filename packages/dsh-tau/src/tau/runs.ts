/**
 * The runs of taus, and their boxes (docs/dsh-tau/tau/index.md), which the
 * tau backend (./service.ts) serves to tau's rpc adaptor: a run's call, tau's archive of the run's
 * envelope with the content of its files, and the tau (tau's
 * docs/spec/serialization.md), is admitted (./admission.ts) and kept in the
 * session's folder; a box is made for it by fleet's gateway, with every
 * service registered then, which dsh-tau lays out from the call
 * (./placement.ts); the session is registered (./registry.ts); and its box
 * is kept (./session-box.ts), started, stopped, removed and set up again,
 * with the tau's init run in it. Once the run ended, what its agent left is
 * got back from its box, and packed as its result, which is kept, checked.
 * It never learns a caller's paths: the caller's adaptor packs the call, and
 * puts the result at them. It uses nothing of dsh's, so both dsh-tau's world
 * (../world/), which serves a tau's session from its box, through
 * {@link TauBoxes}, and the tau backend (./service.ts), which makes the
 * session, through {@link RunLifecycle}, build on it.
 * @module @sleepymug/dsh-tau/tau/runs
 */

import { createReadStream } from 'node:fs'
import { mkdir, open, realpath, rm } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { SpawnRequestSchema } from '@sleepymug/fleet-protocol/box'
import type { Outcome } from '@sleepymug/tau/core'
import type { Platform } from '../platform.ts'
import { messageOf } from '../util/error.ts'
import { spool, streamOf } from '../util/stream.ts'
import { admit, type Accepted } from './admission.ts'
import { CONTEXT, CONTEXT_VARIABLE } from './layout.ts'
import { furnish, packIn, placed } from './placement.ts'
import type { About, FleetPort, Held, InitEnd, Occupant, RunBox, RunLifecycle, ServiceInfo, Started, TauBoxes } from './ports.ts'
import { HOST, type Caller, type Entry, type Registry } from './registry.ts'
import { SessionBox } from './session-box.ts'

/** How long a run's init, cancelled, has after SIGTERM before SIGKILL. */
const INIT_GRACE_MS = 5_000

/** How long a run's box, started, runs while nothing occupies it, unless the runs are told otherwise. */
const IDLE_STOP_MS = 60_000

/** The label of a run's box that names its session. */
const SESSION_LABEL = 'dsh.session'

/** The environment of every process in a tau's box: where its run's context is. */
export const BOX_ENV: Record<string, string> = {
  [CONTEXT_VARIABLE]: CONTEXT,
}

/** What the runs are built on. */
export interface TauRunsDeps {
  registry: Registry
  /** fleet's gateway, which keeps the boxes. */
  fleet: FleetPort
  platform: Platform
  /** How long a box, started, runs while nothing occupies it before it is stopped; a minute without it. */
  idleStopMs?: number
  /** The image a box runs; the gateway's default without it. */
  image?: string
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
  private readonly fleet: FleetPort
  private readonly platform: Platform
  private readonly idleStopMs: number
  private readonly image: string | undefined

  constructor({ registry, fleet, platform, idleStopMs, image }: TauRunsDeps) {
    this.registry = registry
    this.fleet = fleet
    this.platform = platform
    this.idleStopMs = idleStopMs ?? IDLE_STOP_MS
    this.image = image
  }

  /**
   * Find the sessions the registry has, before anyone asks which sessions
   * are a tau's, and follow their boxes, so that one left running, as by a
   * dsh before this one, is stopped once it is idle, at once if its run
   * ended; then sweep what such a dsh left half done.
   */
  async load(): Promise<void> {
    for (const sessionId of await this.registry.list()) {
      const { project, cwd, box, ended } = await this.registry.get(sessionId)
      const kept = this.sessionBox(sessionId, box)
      if (ended !== undefined) void kept.runEnded()
      this.runs.set(sessionId, { project, cwd, box: kept })
    }
    await this.sweep()
  }

  /**
   * Remove what a dsh that died on the way left, as the runs load, before
   * any run is set up: the boxes and the folder of a session it was setting
   * up, or forgetting, which has a folder and no entry, and a session's
   * boxes other than its entry's, made as its box was set up again. Only
   * boxes labelled with a session of this registry's are touched, so
   * another dsh's on the same gateway are not; what cannot be removed now
   * is logged, and swept as the runs next load.
   */
  private async sweep(): Promise<void> {
    const orphans = new Set(await this.registry.orphans())
    let boxes
    try {
      boxes = await this.fleet.list()
    } catch (error) {
      this.platform.log(`could not list the boxes to sweep: ${messageOf(error)}`)
      return
    }
    for (const { id, labels } of boxes) {
      const sessionId = labels[SESSION_LABEL]
      if (sessionId === undefined) continue
      const run = this.runs.get(sessionId)
      if (run === undefined ? !orphans.has(sessionId) : run.box.box === id) continue
      try {
        await this.fleet.box(id).remove()
        this.platform.log(`removed the box ${id}, which ${sessionId} left`)
      } catch (error) {
        this.platform.log(`could not remove the box ${id}, which ${sessionId} left: ${messageOf(error)}`)
        orphans.delete(sessionId)
      }
    }
    for (const sessionId of orphans) await this.registry.delete(sessionId)
  }

  /**
   * Set up a box for a run of a call. First the call is admitted as it
   * comes, and kept in the session's folder. Then the box is made by the
   * gateway, with every service registered now, and laid out from the
   * call, which says the prompt, the files and where things are, started
   * to be; and the session is registered. The box then stops once it is
   * idle, unless the run's start uses it first. A failure removes the box
   * and the session's folder.
   * @param call - tau's archive of the call, which carries the tau.
   * @param caller - the host's `tau` command, or a session: a tau's, from its box, whose runs are in its project, or another, with `tau_run`.
   */
  async create(call: AsyncIterable<Uint8Array>, about: About, caller: Caller = HOST): Promise<Started> {
    const sessionId = `session-${this.platform.newId()}`
    const project = await this.projectFor(caller, about)
    const files = this.registry.files(sessionId)
    await mkdir(files.folder, { recursive: true, mode: 0o700 })
    try {
      let accepted
      try {
        accepted = await admit(spool(call, files.call), { scratch: files.tau, title: about.title })
      } catch (error) {
        // A call that does not fit its tau, or breaks the spec, is its caller's to change.
        throw new ConnectError(messageOf(error), Code.InvalidArgument, undefined, undefined, error)
      }
      return await this.setUp(sessionId, accepted, about, project, caller)
    } catch (error) {
      await rm(files.folder, { recursive: true, force: true })
      throw error
    }
  }

  private async setUp(sessionId: string, accepted: Accepted, about: About, project: string, caller: Caller): Promise<Started> {
    const parent: Record<string, string> = caller.kind === 'session' ? { 'tau.parent': caller.sessionId } : {}
    const id = await this.makeBox(sessionId, { 'tau.title': about.title, ...parent })
    const box = this.fleet.box(id)
    let setup
    try {
      await box.start()
      setup = await furnish(box, this.registry.files(sessionId).call, this.scratch(sessionId))
      await this.registry.put({
        sessionId,
        caller,
        box: id,
        title: about.title,
        project,
        prompt: setup.prompt,
        ...setup.init === undefined ? {} : { init: { command: setup.init, dir: setup.cwd } },
        promptRequestId: this.platform.newId(),
        files: placed(accepted, setup),
        cwd: setup.cwd,
        skills: accepted.skills,
        createdAt: this.platform.now().toISOString(),
      })
    } catch (error) {
      await box.remove().catch(() => {})
      throw error
    }
    this.runs.set(sessionId, { project, cwd: setup.cwd, box: this.sessionBox(sessionId, id) })
    this.platform.log(`created ${sessionId} in ${id}, with the prompt:\n${setup.prompt.trimEnd()}`)
    return { sessionId, box: id, prompt: setup.prompt }
  }

  /** Make a session's box with the gateway, its labels naming the session, with every service registered now, and give its id. */
  private async makeBox(sessionId: string, labels: Record<string, string>): Promise<string> {
    return await this.fleet.create({
      labels: { [SESSION_LABEL]: sessionId, ...labels },
      env: BOX_ENV,
      services: (await this.fleet.services()).map(service => service.name),
      ...this.image === undefined ? {} : { image: this.image },
    })
  }

  /**
   * Set a session's box up again from the run's call, which is kept, in a
   * box made anew, its old one gone; what the agent did in the box before is
   * gone. The entry records the new box, and when, so the agent is told once
   * (../preset/reset.ts).
   * @returns the new box's id.
   */
  private async rebuild(sessionId: string): Promise<string> {
    const entry = await this.registry.get(sessionId)
    const files = this.registry.files(sessionId)
    let id: string | undefined
    try {
      const accepted = await admit(createReadStream(files.call), { scratch: files.tau, title: entry.title })
      const parent: Record<string, string> = entry.caller?.kind === 'session' ? { 'tau.parent': entry.caller.sessionId } : {}
      id = await this.makeBox(sessionId, { 'tau.title': entry.title, ...parent })
      await this.fleet.box(id).start()
      const setup = await furnish(this.fleet.box(id), files.call, this.scratch(sessionId))
      await this.registry.put({
        ...entry,
        box: id,
        files: placed(accepted, setup),
        cwd: setup.cwd,
        skills: accepted.skills,
        resetAt: this.platform.now().toISOString(),
      })
      const run = this.runs.get(sessionId)
      if (run !== undefined) run.cwd = setup.cwd
      this.platform.log(`set up the box of ${sessionId} again, from its call, in ${id}, its box ${entry.box} gone`)
      return id
    } catch (error) {
      if (id !== undefined) await this.fleet.box(id).remove().catch(() => {})
      throw new Error(`dsh-tau: could not set up the box of ${sessionId} again: ${messageOf(error)}`, { cause: error })
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
    if (about.project === undefined || !posix.isAbsolute(about.project)) throw new ConnectError('dsh-tau: a run from outside a box names its project, an absolute path', Code.InvalidArgument)
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
    if (init === undefined) throw new Error(`dsh-tau: the tau of ${sessionId} has no init`)
    const held = await this.hold(sessionId, { kind: 'process', id: this.platform.newId() })
    if (held === undefined) throw new Error(`dsh-tau: no tau session ${sessionId}`)
    const { box, release } = held
    try {
      signal.throwIfAborted()
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let end: InitEnd | undefined
      // Cancelling the call, as the signal does, ends the command's process group.
      for await (const { response } of box.api.spawn(streamOf(create(SpawnRequestSchema, {
        request: { case: 'start', value: { program: { argv: ['sh', '-c', init.command], cwd: init.dir }, graceMs: INIT_GRACE_MS } },
      })), { signal })) {
        if (response.case === 'stdout') stdout.push(Buffer.from(response.value))
        else if (response.case === 'stderr') stderr.push(Buffer.from(response.value))
        else if (response.case === 'exit') {
          end = {
            code: response.value.code ?? null,
            signal: response.value.signal === '' ? null : response.value.signal,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          }
        }
      }
      if (end === undefined) throw new Error('the box said nothing of how the init ended')
      return end
    } finally {
      release()
    }
  }

  async prompted(sessionId: string): Promise<void> {
    await this.registry.update(sessionId, { promptedAt: this.platform.now().toISOString() })
  }

  async ended(sessionId: string, result: Outcome): Promise<void> {
    await this.registry.update(sessionId, { ended: { at: this.platform.now().toISOString(), result } })
  }

  /**
   * Keep the result of a session's run, which ended as `outcome` says, in
   * the session's folder: for a run that succeeded, what the agent left at
   * the places of its `out` and `inout` files, got back from its box and
   * checked against the run (./placement.ts); a run that failed gives back
   * nothing.
   * @returns how the run ended, as its result has it.
   */
  async pack(sessionId: string, outcome: Outcome): Promise<Outcome> {
    return await this.run(sessionId).box.exclusive(async (running) => {
      const { files } = await this.registry.get(sessionId)
      const kept = this.registry.files(sessionId)
      await mkdir(kept.folder, { recursive: true, mode: 0o700 })
      return await packIn(running, outcome, files, kept.result, this.scratch(sessionId))
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

  isTau(sessionId: string): boolean {
    return this.runs.has(sessionId)
  }

  /** The services a session's box was made with, each as registered now; one no longer registered is left out. */
  async services(sessionId: string): Promise<ServiceInfo[]> {
    const has = new Set(await this.fleet.box(this.run(sessionId).box.box).services())
    return (await this.fleet.services()).filter(service => has.has(service.name))
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

  async runEnded(sessionId: string): Promise<void> {
    await this.runs.get(sessionId)?.box.runEnded()
  }

  async whenStarted(sessionId: string, signal: AbortSignal): Promise<RunBox> {
    return await this.run(sessionId).box.whenStarted(signal)
  }

  copyInOnce(sessionId: string, from: string, to: string): void {
    this.runs.get(sessionId)?.box.copyInOnce(from, to)
  }

  /** Start a session's box, set up again if it is gone; a session that is not a tau's fails. */
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

  /** Stop following the boxes, and stop those started: nothing uses them once the runs close. */
  async close(): Promise<void> {
    await Promise.all([...this.runs].map(async ([sessionId, run]) => {
      await run.box.close().catch((error: unknown) => {
        this.platform.log(`could not stop the box of ${sessionId}: ${messageOf(error)}`)
      })
    }))
  }

  /** A folder of a session's, where its box is laid out, and its result got back, while it is. */
  private scratch(sessionId: string): string {
    return join(this.registry.files(sessionId).folder, `box-${this.platform.newId()}`)
  }

  /** A tau's session; another fails. */
  private run(sessionId: string): Run {
    const run = this.runs.get(sessionId)
    if (run === undefined) throw new Error(`dsh-tau: no tau session ${sessionId}`)
    return run
  }

  /** A session's box, followed from now on. */
  private sessionBox(sessionId: string, box: string): SessionBox {
    const kept = new SessionBox({ sessionId, box, fleet: this.fleet, platform: this.platform, idleStopMs: this.idleStopMs, rebuild: () => this.rebuild(sessionId) })
    kept.follow()
    return kept
  }

  /** The session whose box `box` is, if a tau's: whose runs a connection from it may make. */
  sessionOfBox(box: string): string | undefined {
    for (const [sessionId, run] of this.runs) if (run.box.box === box) return sessionId
    return undefined
  }
}
