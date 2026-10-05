/**
 * The tau service (docs/fleet-core/tau/index.md), what `fleet` asks of the
 * fleet host: it starts a run of a call, tau's archive of a run, with its
 * box (./runs.ts) and its dsh session, in the caller's folder as its
 * workspace, which it gives the prompt; watches the run until its agent is
 * done, has its box pack what it gave back, and records how it ended
 * (./outcome.ts); gives back its result, and where the caller has its
 * handles, for the caller to put what the run gave back there; and cancels
 * the run, and deletes it with its box. It never reads or writes a caller's
 * files, so it serves `fleet`, on the host, which reaches every run, and a
 * session, a tau's from its box or another with `tau_run`, which reaches
 * only the runs it started, alike; a run's end deletes those it started and
 * did not finish, and its deletion all it started. The service reaches dsh's sessions only through
 * {@link Sessions}.
 * @module fleet-core/tau/service
 */

import type { Finished, Result, RunStatus, Started } from 'fleet-protocol/tau'
import { resultOf, type Outcome } from './outcome.ts'
import type { Caller, Entry } from './registry.ts'
import { HOST, type About, type TauRuns } from './runs.ts'

/** What the service does with dsh's sessions (./plugin.ts). */
export interface Sessions {
  /**
   * Make a session with this id, in the dsh workspace of the folder, with
   * the title; one already made is kept as it is.
   */
  create(sessionId: string, project: string, title: string): Promise<void>
  /** Give a session a prompt, once for each request id. */
  prompt(sessionId: string, requestId: string, text: string): Promise<void>
  /** Cancel a session's turn, if one runs. */
  cancel(sessionId: string): void
  /** Archive a session, stopping its work; one never made is let be. */
  archive(sessionId: string): Promise<void>
  /**
   * Wait until a session's agent is done with what it was given, if it is
   * at work here, and read how the session ended.
   * @param signal - gives up the wait.
   */
  settled(sessionId: string, signal: AbortSignal): Promise<Outcome>
  /** A session's events, oldest first, as dsh logs them. */
  history(sessionId: string, signal: AbortSignal): Promise<unknown[]>
}

export class TauService {
  /** Each session's last operation, which its next one waits for. */
  private readonly queues = new Map<string, Promise<void>>()
  /** Each run watched until it ends, by its session. */
  private readonly watches = new Map<string, Promise<void>>()
  /** Aborts the watches as the service closes. */
  private readonly closing = new AbortController()
  /** dsh's archived sessions, as {@link followArchive} was last told. */
  private archivedSessions: ReadonlySet<string> = new Set()

  constructor(
    private readonly runs: TauRuns,
    private readonly sessions: Sessions,
    private readonly log: (message: string) => void,
  ) {}

  /** Watch the runs the registry has that have not ended, as a service started later does. */
  async load(): Promise<void> {
    for (const entry of await this.runs.list()) {
      if (entry.ended === undefined) void this.watch(entry.sessionId)
    }
  }

  /**
   * Start a run of a call: set up its box (./runs.ts), start it, make the
   * dsh session, and give it the prompt. A failure on the way undoes it all.
   * Then the run is watched until it ends.
   * @param caller - who starts it: `fleet`, on the host, or a session: a tau's, from its box, or another, with `tau_run`.
   * @param call - tau's archive of the call, which carries the tau.
   */
  async start(caller: Caller, about: About, call: AsyncIterable<Uint8Array>): Promise<Started> {
    const started = await this.runs.create(call, about, caller)
    const { sessionId } = started
    let project: string | undefined
    try {
      await this.serial(sessionId, async () => {
        const entry = await this.runs.entry(sessionId)
        project = entry.project
        await this.runs.start(sessionId)
        await this.sessions.create(sessionId, entry.project, entry.title)
        await this.sessions.prompt(sessionId, entry.promptRequestId, entry.prompt)
        await this.runs.prompted(sessionId)
      })
    } catch (error) {
      await this.serial(sessionId, async () => {
        await this.sessions.archive(sessionId)
        await this.runs.remove(sessionId)
      }).catch((undoing: unknown) => { this.log(`could not undo the start of ${sessionId}: ${message(undoing)}`) })
      throw error
    }
    this.log(`started ${sessionId} in ${String(project)}, and gave it its prompt`)
    void this.watch(sessionId)
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
   * Wait until a run ends, and give back how it did, where the caller has
   * its handles, and its result's archive, which holds what it gave back for
   * them, the same each time; and, if asked, its session's history.
   * @param signal - gives up the wait; the run goes on.
   */
  async finish(caller: Caller, sessionId: string, signal: AbortSignal, options: { history?: boolean } = {}): Promise<Finished & { archive: AsyncIterable<Uint8Array> }> {
    if ((await this.reach(caller, sessionId)).ended === undefined) await abortable(this.watch(sessionId), signal)
    const history = options.history === true ? await this.sessions.history(sessionId, signal) : undefined
    return await this.serial(sessionId, async () => {
      const { ended, finishedAt, targets } = await this.runs.entry(sessionId)
      if (ended === undefined) throw new Error(`fleet: the fleet host stopped before ${sessionId} ended`)
      const archive = await this.runs.result(sessionId)
      if (finishedAt === undefined) await this.runs.finished(sessionId)
      return { result: ended.result, targets, ...history === undefined ? {} : { history }, archive }
    })
  }

  /** Cancel a run's turn, which ends the run; a run that ended is let be. */
  async cancel(caller: Caller, sessionId: string): Promise<void> {
    await this.reach(caller, sessionId)
    await this.serial(sessionId, async () => {
      const entry = await this.runs.entry(sessionId)
      if (entry.promptedAt !== undefined && entry.ended === undefined) this.sessions.cancel(sessionId)
    })
  }

  /**
   * Archive a run's session, remove its box, running or not, and forget the
   * run; and so with the runs it started, first.
   */
  async delete(caller: Caller, sessionId: string): Promise<void> {
    await this.reach(caller, sessionId)
    await this.deleteChildren(sessionId, () => true)
    await this.serial(sessionId, async () => {
      const entry = await this.runs.entry(sessionId)
      await this.sessions.archive(sessionId)
      await this.runs.remove(sessionId)
      this.log(`deleted ${sessionId} and its box ${entry.box}`)
    })
  }

  /**
   * A run's entry, if the caller reaches it: the host reaches every run, a
   * tau's session the runs it started. Another is as if it were not there.
   */
  private async reach(caller: Caller, sessionId: string): Promise<Entry> {
    const entry = await this.runs.entry(sessionId)
    if (!reaches(caller, entry)) throw new Error(`fleet: no tau session ${sessionId}`)
    return entry
  }

  /** Delete the runs a run started that `which` picks, and theirs. */
  private async deleteChildren(parent: string, which: (entry: Entry) => boolean): Promise<void> {
    const children = (await this.runs.list()).filter(entry => entry.caller?.kind === 'session' && entry.caller.sessionId === parent && which(entry))
    for (const child of children) {
      await this.delete(HOST, child.sessionId).catch((error: unknown) => {
        this.log(`could not delete ${child.sessionId}, which ${parent} started: ${message(error)}`)
      })
    }
  }

  /**
   * Follow dsh's archived sessions: a run whose session is archived, or was
   * started, however indirectly, by one that is, has its box removed once
   * the run ended, keeping its entry and result; one no longer archived has
   * a box again on its next use, set up from its call ({@link TauRuns.archive}).
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
        this.log(`could not remove the box of ${sessionId}, which is archived: ${message(error)}`)
      }
    }))
  }

  /** Stop watching the runs; a service started later watches them again. */
  async close(): Promise<void> {
    this.closing.abort()
    await Promise.all(this.watches.values())
  }

  /**
   * Watch a run until it ends, once however many ask: record how it ended,
   * and stop its box. It settles once the run's end is recorded, or the run
   * is gone, or the service closes.
   */
  private watch(sessionId: string): Promise<void> {
    const known = this.watches.get(sessionId)
    if (known !== undefined) return known
    const watching = this.untilEnd(sessionId).catch((error: unknown) => {
      if (!this.closing.signal.aborted && this.runs.isTau(sessionId)) this.log(`could not record how ${sessionId} ended: ${message(error)}`)
    }).finally(() => {
      if (this.watches.get(sessionId) === watching) this.watches.delete(sessionId)
    })
    this.watches.set(sessionId, watching)
    return watching
  }

  private async untilEnd(sessionId: string): Promise<void> {
    // After the start's own operations, so a start under way has given the prompt.
    const prompted = await this.serial(sessionId, async () => (await this.runs.entry(sessionId)).promptedAt !== undefined)
    let result: Result
    if (!prompted) {
      result = { ok: false, text: '', failure: 'the fleet host stopped before the run got its prompt' }
    } else {
      try {
        result = resultOf(await this.sessions.settled(sessionId, this.closing.signal))
      } catch (error) {
        if (this.closing.signal.aborted) throw error
        result = { ok: false, text: '', failure: `could not read how the run ended: ${message(error)}` }
      }
    }
    await this.serial(sessionId, async () => {
      // Deleted meanwhile, or ended already, as by a watch before a restart.
      if (!this.runs.isTau(sessionId) || (await this.runs.entry(sessionId)).ended !== undefined) return
      result = await this.runs.pack(sessionId, result)
      await this.runs.ended(sessionId, result)
      this.log(`${sessionId} ended${result.ok ? '' : `, failing: ${String(result.failure)}`}`)
      // At once, unless something else uses the box, such as a user's terminal: then once it no longer does.
      await this.runs.stopWhenVacant(sessionId).catch((error: unknown) => { this.log(`could not stop the box of ${sessionId}: ${message(error)}`) })
    })
    // What it started and did not finish cannot give back anything now: its box is its caller's.
    await this.deleteChildren(sessionId, entry => entry.finishedAt === undefined)
  }

  /** Run a session's operations one after another, so that a run's start, end, finish and deletion keep their order. */
  private serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(sessionId) ?? Promise.resolve()).then(operation)
    const settled = next.then(() => {}, () => {})
    this.queues.set(sessionId, settled)
    void settled.then(() => { if (this.queues.get(sessionId) === settled) this.queues.delete(sessionId) })
    return next
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
    state,
    createdAt: entry.createdAt,
    ...entry.ended === undefined ? {} : { endedAt: entry.ended.at, result: entry.ended.result },
  }
}

/** Whether a caller reaches a run: the host every run, a session those it started. */
function reaches(caller: Caller, entry: Entry): boolean {
  return caller.kind === 'host' || (entry.caller?.kind === 'session' && entry.caller.sessionId === caller.sessionId)
}

/** Stop waiting for a promise when the signal aborts; what it waits for goes on. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
