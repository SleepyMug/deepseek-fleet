/**
 * The tau service (docs/fleet-core/tau/index.md), what `fleet` asks of the
 * fleet host: it starts a run of a tau, with its box (./runs.ts) and its dsh
 * session, in the caller's folder as its workspace, which it gives the
 * prompt; watches the run until its agent is done, copies out what it gave
 * back and checks it, and records how it ended (./outcome.ts); gives that
 * back, putting what the run gave back at the caller's paths; and cancels
 * the run, and deletes it with its box. The service reaches dsh's sessions only through {@link Sessions}.
 * @module fleet-core/tau/service
 */

import { basename } from 'node:path'
import type { Result, RunStatus, Started, Values } from 'fleet-protocol/tau'
import { resultOf, type Outcome } from './outcome.ts'
import type { Entry } from './registry.ts'
import type { TauRuns } from './runs.ts'

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
}

export class TauService {
  /** Each session's last operation, which its next one waits for. */
  private readonly queues = new Map<string, Promise<void>>()
  /** Each run watched until it ends, by its session. */
  private readonly watches = new Map<string, Promise<void>>()
  /** Aborts the watches as the service closes. */
  private readonly closing = new AbortController()

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
   * Start a run of a tau: set up its box (./runs.ts), start it, make the
   * dsh session, and give it the prompt. A failure on the way undoes it all.
   * Then the run is watched until it ends.
   * @param tauDir - the tau's directory, absolute.
   * @param values - the run's values, by parameter.
   * @param callerCwd - what relative paths in `values` are relative to, absolute.
   */
  async start(tauDir: string, values: Values, callerCwd: string): Promise<Started> {
    const started = await this.runs.create(tauDir, values, callerCwd)
    const { sessionId } = started
    let project: string | undefined
    try {
      await this.serial(sessionId, async () => {
        const entry = await this.runs.entry(sessionId)
        project = entry.project
        await this.runs.start(sessionId)
        await this.sessions.create(sessionId, entry.project, basename(entry.tauDir))
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
  async status(sessionId: string): Promise<RunStatus> {
    return statusOf(await this.runs.entry(sessionId))
  }

  /** Every run, oldest first. */
  async list(): Promise<RunStatus[]> {
    return (await this.runs.list()).map(statusOf)
  }

  /**
   * Wait until a run ends, and give back how it did, the same each time.
   * The first time, a run that succeeded puts what it gave back at the
   * caller's paths, which a finish that fails on the way does again.
   * @param signal - gives up the wait; the run goes on.
   */
  async finish(sessionId: string, signal: AbortSignal): Promise<Result> {
    if ((await this.runs.entry(sessionId)).ended === undefined) await abortable(this.watch(sessionId), signal)
    return await this.serial(sessionId, async () => {
      const { ended, finishedAt } = await this.runs.entry(sessionId)
      if (ended === undefined) throw new Error(`fleet: the fleet host stopped before ${sessionId} ended`)
      if (finishedAt === undefined) {
        // What a run that failed left is not given back.
        if (ended.result.ok) await this.runs.publish(sessionId)
        await this.runs.finished(sessionId)
      }
      return ended.result
    })
  }

  /** Cancel a run's turn, which ends the run; a run that ended is let be. */
  async cancel(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      const entry = await this.runs.entry(sessionId)
      if (entry.promptedAt !== undefined && entry.ended === undefined) this.sessions.cancel(sessionId)
    })
  }

  /** Archive a run's session, remove its box, running or not, and forget the run. */
  async delete(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      const entry = await this.runs.entry(sessionId)
      await this.sessions.archive(sessionId)
      await this.runs.remove(sessionId)
      this.log(`deleted ${sessionId} and its box ${entry.box}`)
    })
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
      if (result.ok) {
        const unfit = await this.runs.collect(sessionId).catch((error: unknown) => `could not copy out what the run gave back: ${message(error)}`)
        if (unfit !== undefined) result = { ok: false, text: result.text, failure: unfit }
      }
      await this.runs.ended(sessionId, result)
      this.log(`${sessionId} ended${result.ok ? '' : `, failing: ${String(result.failure)}`}`)
      await this.runs.stop(sessionId).catch((error: unknown) => { this.log(`could not stop the box of ${sessionId}: ${message(error)}`) })
    })
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
    tauDir: entry.tauDir,
    project: entry.project,
    state,
    createdAt: entry.createdAt,
    ...entry.ended === undefined ? {} : { endedAt: entry.ended.at, result: entry.ended.result },
  }
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
