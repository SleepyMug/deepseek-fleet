/**
 * The tau service (docs/fleet-core/tau/index.md), the backend of tau's
 * fleet adaptor (tau's docs/spec/fleet.md), which its requests reach
 * through ./wire.ts: it submits a run of a call, tau's archive of a run,
 * with its box (./runs.ts) and its dsh session, in the caller's folder as
 * its workspace, which it gives the prompt, once the tau's init, if it has
 * one, asks for the agent (./init.ts); watches the run until its agent is
 * done, or its init did the run, has its box pack what it gave back, and
 * records how it ended; gives back its result, for the
 * caller's adaptor to check and put at the caller's paths; and releases the
 * run, archiving its session and removing its box, or, as its config may
 * have it, keeping both, the session a person's to go on with. It never learns a caller's paths, so it serves the
 * host's `tau` command, which reaches every run, and a session, a tau's from
 * its box or another with `tau_run`, which reaches only the runs it
 * started, alike; a run's end releases those it started and did not finish,
 * and its release all it started. The service reaches dsh's sessions only
 * through {@link Sessions}.
 * @module @sleepymug/fleet-core/tau/service
 */

import type { FleetHandler } from '@sleepymug/tau/adaptors'
import type { Result, RunStatus } from '@sleepymug/fleet-protocol/tau'
import type { Platform } from '../platform.ts'
import { abortable } from '../util/abort.ts'
import { messageOf } from '../util/error.ts'
import { KeyedQueue } from '../util/queue.ts'
import { fellBack, nextOf } from './init.ts'
import type { About, RunLifecycle, Started } from './ports.ts'
import { HOST, type Caller, type Entry } from './registry.ts'
import { serveFor } from './wire.ts'

/** What the service does with dsh's sessions (../dsh/sessions.ts). */
export interface Sessions {
  /**
   * Make a session with this id, in the dsh workspace of the folder, with
   * the title; one already made is kept as it is.
   */
  create(sessionId: string, project: string, title: string): Promise<void>
  /** Give a session a prompt, once for each request id. */
  prompt(sessionId: string, requestId: string, text: string): Promise<void>
  /** Archive a session, stopping its work; one never made is let be. */
  archive(sessionId: string): Promise<void>
  /** Stop a session's work, keeping the session: its turn is cancelled, and what is queued dropped. */
  stop(sessionId: string): Promise<void>
  /**
   * Wait until a session's agent is done with what it was given, if it is
   * at work here, and read how the session ended, as a run's result: it
   * succeeded if the agent finished its last turn, with the last text it
   * wrote, and why not otherwise.
   * @param signal - gives up the wait.
   */
  settled(sessionId: string, signal: AbortSignal): Promise<Result>
  /** A session's events, oldest first, as dsh logs them. */
  history(sessionId: string, signal: AbortSignal): Promise<unknown[]>
}

/** What the service is built on. */
export interface TauServiceDeps {
  runs: RunLifecycle
  sessions: Sessions
  platform: Platform
  /** Whether a run's release keeps its session, with its box, rather than archive it and remove its box; read at each release, false by default. */
  keepSessions?: () => boolean
}

export class TauService {
  /** Each session's operations, one after another, so that a run's start, end, finish and release keep their order. */
  private readonly queue = new KeyedQueue<string>()
  /** Each run watched until it ends, by its session. */
  private readonly watches = new Map<string, Promise<void>>()
  /** What stops each run whose init runs, or whose prompt follows its init, by its session. */
  private readonly inits = new Map<string, AbortController>()
  /** Aborts the watches as the service closes. */
  private readonly closing = new AbortController()
  /** dsh's archived sessions, as {@link followArchive} was last told. */
  private archivedSessions: ReadonlySet<string> = new Set()

  private readonly runs: RunLifecycle
  private readonly sessions: Sessions
  private readonly log: (message: string) => void
  private readonly keepSessions: () => boolean

  constructor({ runs, sessions, platform, keepSessions = () => false }: TauServiceDeps) {
    this.runs = runs
    this.sessions = sessions
    this.log = platform.log
    this.keepSessions = keepSessions
  }

  /**
   * The service's requests, as tau's fleet adaptor and fleet-protocol have
   * them, made by `caller`, whom the way in names (./wire.ts).
   */
  handlerFor(caller: Caller): FleetHandler {
    return serveFor(this, caller)
  }

  /** Watch the runs the registry has that have not ended, as a service started later does. */
  async load(): Promise<void> {
    for (const entry of await this.runs.list()) {
      if (entry.ended === undefined) void this.watch(entry.sessionId)
    }
  }

  /**
   * Submit a run of a call: set up its box (./runs.ts), start it, make the
   * dsh session, and give it the prompt, unless its tau has an init, which
   * the watch runs first. A failure on the way undoes it all. Then the run
   * is watched until it ends.
   * @param caller - who submits it: the host's `tau` command, or a session: a tau's, from its box, or another, with `tau_run`.
   * @param call - tau's archive of the call, which carries the tau.
   */
  async submit(caller: Caller, about: About, call: AsyncIterable<Uint8Array>): Promise<Started> {
    const started = await this.runs.create(call, about, caller)
    const { sessionId } = started
    let project: string | undefined
    let init = false
    try {
      await this.serial(sessionId, async () => {
        const entry = await this.runs.entry(sessionId)
        project = entry.project
        init = entry.init !== undefined
        await this.runs.start(sessionId)
        await this.sessions.create(sessionId, entry.project, entry.title)
        if (init) return
        await this.sessions.prompt(sessionId, entry.promptRequestId, entry.prompt)
        await this.runs.prompted(sessionId)
      })
    } catch (error) {
      await this.serial(sessionId, async () => {
        await this.sessions.archive(sessionId)
        await this.runs.remove(sessionId)
      }).catch((undoing: unknown) => { this.log(`could not undo the start of ${sessionId}: ${messageOf(undoing)}`) })
      throw error
    }
    this.log(`started ${sessionId} in ${String(project)}, ${init ? 'to run its init' : 'and gave it its prompt'}`)
    void this.watch(sessionId, init)
    return started
  }

  /** Where a run is, and how it ended, once it did. */
  async status(caller: Caller, sessionId: string): Promise<RunStatus> {
    return statusOf(await this.reach(caller, sessionId))
  }

  /** Every run the caller reaches, oldest first. */
  async list(caller: Caller): Promise<RunStatus[]> {
    return (await this.runs.list()).filter(entry => reaches(caller, entry)).map(statusOf)
  }

  /**
   * Wait until a run ends, and give back its result's archive: how it
   * ended, and what it gave back for its `out` and `inout` files, the same
   * each time.
   * @param signal - gives up the wait; the run goes on.
   */
  async finish(caller: Caller, sessionId: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    await this.untilEnded(caller, sessionId, signal)
    return await this.serial(sessionId, async () => {
      const { ended, finishedAt } = await this.runs.entry(sessionId)
      if (ended === undefined) throw new Error(`fleet: the fleet host stopped before ${sessionId} ended`)
      const archive = await this.runs.result(sessionId)
      if (finishedAt === undefined) await this.runs.finished(sessionId)
      return archive
    })
  }

  /**
   * Wait until a run ends, its result kept.
   * @param signal - gives up the wait; the run goes on.
   */
  async untilEnded(caller: Caller, sessionId: string, signal: AbortSignal): Promise<void> {
    if ((await this.reach(caller, sessionId)).ended === undefined) await abortable(this.watch(sessionId), signal)
  }

  /** A run's session's events, oldest first, as dsh logs them, whether the run ended or not. */
  async history(caller: Caller, sessionId: string, signal: AbortSignal): Promise<unknown[]> {
    await this.reach(caller, sessionId)
    return await this.sessions.history(sessionId, signal)
  }

  /**
   * Release a run: stop its init, if it runs, archive its session, which
   * stops its turn, remove its box, running or not, and forget the run; and
   * so with the runs it started, first. With `keepSessions`, the session's
   * turn is stopped instead, and the session kept, with its box, which
   * stops once the run's end is recorded, and its entry, which no caller
   * reaches since: the session is a person's, as any tau's session is, and
   * archiving it removes its box.
   */
  async release(caller: Caller, sessionId: string): Promise<void> {
    await this.reach(caller, sessionId)
    this.inits.get(sessionId)?.abort()
    await this.releaseChildren(sessionId, () => true)
    await this.serial(sessionId, async () => {
      const entry = await this.runs.entry(sessionId)
      if (this.keepSessions()) {
        await this.sessions.stop(sessionId)
        await this.runs.released(sessionId)
        this.log(`released ${sessionId}, keeping its session and its box ${entry.box}`)
        return
      }
      await this.sessions.archive(sessionId)
      await this.runs.remove(sessionId)
      this.log(`released ${sessionId}, and removed its box ${entry.box}`)
    })
  }

  /**
   * A run's entry, if the caller reaches it: the host reaches every run, a
   * tau's session the runs it started, but a run released with its session
   * kept. Another is as if it were not there.
   */
  private async reach(caller: Caller, sessionId: string): Promise<Entry> {
    const entry = await this.runs.entry(sessionId)
    if (!reaches(caller, entry)) throw new Error(`fleet: no tau session ${sessionId}`)
    return entry
  }

  /** Release the runs a run started that `which` picks, and theirs. */
  private async releaseChildren(parent: string, which: (entry: Entry) => boolean): Promise<void> {
    const children = (await this.runs.list()).filter(entry => reaches({ kind: 'session', sessionId: parent }, entry) && which(entry))
    for (const child of children) {
      await this.release(HOST, child.sessionId).catch((error: unknown) => {
        this.log(`could not release ${child.sessionId}, which ${parent} started: ${messageOf(error)}`)
      })
    }
  }

  /**
   * Follow dsh's archived sessions: a run whose session is archived, or was
   * started, however indirectly, by one that is, has its box removed once
   * the run ended, keeping its entry and result; one no longer archived has
   * a box again on its next use, set up from its call (./runs.ts).
   * @param archived - every archived session, as dsh has them now.
   */
  async followArchive(archived: ReadonlySet<string>): Promise<void> {
    this.archivedSessions = archived
    if (this.closing.signal.aborted) return
    const entries = new Map((await this.runs.list()).map(entry => [entry.sessionId, entry]))
    const under = (entry: Entry | undefined, seen = new Set<string>()): boolean => {
      if (entry === undefined || seen.has(entry.sessionId)) return false
      if (archived.has(entry.sessionId)) return true
      seen.add(entry.sessionId)
      if (entry.caller?.kind !== 'session') return false
      return archived.has(entry.caller.sessionId) || under(entries.get(entry.caller.sessionId), seen)
    }
    await Promise.all([...entries.values()].map(async (entry) => {
      const { sessionId } = entry
      if (!under(entry)) {
        this.runs.unarchive(sessionId)
        return
      }
      if (this.runs.isArchived(sessionId)) return
      try {
        // Its box packs its result as it ends.
        if (entry.ended === undefined) await this.watch(sessionId)
        if (this.archivedSessions === archived) await this.runs.archive(sessionId)
      } catch (error) {
        this.log(`could not remove the box of ${sessionId}, which is archived: ${messageOf(error)}`)
      }
    }))
  }

  /** Stop watching the runs; a service started later watches them again. */
  async close(): Promise<void> {
    this.closing.abort()
    await Promise.all(this.watches.values())
  }

  /**
   * Watch a run until it ends, once however many ask: run its init, if
   * asked, record how it ended, and stop its box. It settles once the run's
   * end is recorded, or the run is gone, or the service closes.
   * @param init - whether to run the init of the run its start just set up.
   */
  private watch(sessionId: string, init = false): Promise<void> {
    const known = this.watches.get(sessionId)
    if (known !== undefined) return known
    const watching = this.untilEnd(sessionId, init).catch((error: unknown) => {
      if (!this.closing.signal.aborted && this.runs.isTau(sessionId)) this.log(`could not record how ${sessionId} ended: ${messageOf(error)}`)
    }).finally(() => {
      if (this.watches.get(sessionId) === watching) this.watches.delete(sessionId)
    })
    this.watches.set(sessionId, watching)
    return watching
  }

  private async untilEnd(sessionId: string, init: boolean): Promise<void> {
    // After the start's own operations, so a start under way has given the prompt.
    const prompted = await this.serial(sessionId, async () => (await this.runs.entry(sessionId)).promptedAt !== undefined)
    // A run its start just set up runs its init first, which ends the run without its agent, or prompts it.
    const initialized = !prompted && init ? await this.initialize(sessionId) : undefined
    let result: Result
    if (initialized !== undefined) {
      result = initialized
    } else if (!prompted && !init) {
      result = { ok: false, text: '', failure: 'the fleet host stopped before the run got its prompt' }
    } else {
      try {
        result = await this.sessions.settled(sessionId, this.closing.signal)
      } catch (error) {
        if (this.closing.signal.aborted) throw error
        result = { ok: false, text: '', failure: `could not read how the run ended: ${messageOf(error)}` }
      }
    }
    await this.serial(sessionId, async () => {
      // Released meanwhile, or ended already, as by a watch before a restart.
      if (!this.runs.isTau(sessionId) || (await this.runs.entry(sessionId)).ended !== undefined) return
      result = await this.runs.pack(sessionId, result)
      await this.runs.ended(sessionId, result)
      this.log(`${sessionId} ended${result.ok ? '' : `, failing: ${String(result.failure)}`}`)
      // At once, unless something else uses the box, such as a user's terminal: then once it no longer does.
      await this.runs.stopWhenVacant(sessionId).catch((error: unknown) => { this.log(`could not stop the box of ${sessionId}: ${messageOf(error)}`) })
    })
    // What it started and did not finish cannot give back anything now: its box is its caller's.
    await this.releaseChildren(sessionId, entry => entry.finishedAt === undefined)
  }

  /**
   * Run a run's init (./init.ts), and then, unless it did the run, give the
   * session its prompt, telling the agent, after it, when init failed. A
   * service that closes meanwhile throws, and leaves the run unprompted.
   * @returns how the run ended without its agent: init did the run, could not run, or the run was released; undefined once the agent has its prompt.
   */
  private async initialize(sessionId: string): Promise<Result | undefined> {
    const cancel = new AbortController()
    this.inits.set(sessionId, cancel)
    const cancelled: Result = { ok: false, text: '', failure: 'the run was released while its init ran' }
    try {
      let end
      try {
        end = await this.runs.init(sessionId, AbortSignal.any([cancel.signal, this.closing.signal]))
      } catch (error) {
        if (this.closing.signal.aborted) throw error
        return cancel.signal.aborted ? cancelled : { ok: false, text: '', failure: `could not run the tau's init: ${messageOf(error)}` }
      }
      this.closing.signal.throwIfAborted()
      const next = nextOf(end)
      this.log(`the init of ${sessionId} ${end.code === null ? `was killed by ${String(end.signal)}` : `exited with ${end.code}`}: ${next}`)
      if (cancel.signal.aborted) return cancelled
      if (next === 'skip') return { ok: true, text: end.stdout }
      return await this.serial(sessionId, async () => {
        // Released once init ended, before this.
        if (cancel.signal.aborted) return cancelled
        const entry = await this.runs.entry(sessionId)
        const prompt = next === 'run' || entry.init === undefined ? entry.prompt : fellBack(entry.prompt, entry.init.command, end)
        await this.sessions.prompt(sessionId, entry.promptRequestId, prompt)
        await this.runs.prompted(sessionId)
        return undefined
      })
    } finally {
      this.inits.delete(sessionId)
    }
  }

  private serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.queue.run(sessionId, operation)
  }
}

/** A run's state, as its registry entry has it. */
function statusOf(entry: Entry): RunStatus {
  const state = entry.finishedAt !== undefined ? 'finished' : entry.ended !== undefined ? 'ended' : 'running'
  return {
    sessionId: entry.sessionId,
    ...entry.caller?.kind === 'session' ? { parent: entry.caller.sessionId } : {},
    title: entry.title,
    project: entry.project,
    prompt: entry.prompt,
    state,
    createdAt: entry.createdAt,
    ...entry.ended === undefined ? {} : { endedAt: entry.ended.at, result: entry.ended.result },
  }
}

/** Whether a caller reaches a run: the host every run, a session those it started, and none a run released with its session kept. */
function reaches(caller: Caller, entry: Entry): boolean {
  if (entry.releasedAt !== undefined) return false
  return caller.kind === 'host' || (entry.caller?.kind === 'session' && entry.caller.sessionId === caller.sessionId)
}
