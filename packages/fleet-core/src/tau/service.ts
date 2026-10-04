/**
 * The tau service (docs/fleet-core/tau/index.md), what `fleet` asks of the
 * fleet host: it creates a run of a tau, with its box (./runs.ts), and
 * starts, stops and deletes the run's session with its box. The first
 * `start` makes the dsh session, in the caller's folder as its workspace, and
 * gives it the prompt. The service reaches dsh's sessions only through
 * {@link Sessions}.
 * @module fleet-core/tau/service
 */

import { basename } from 'node:path'
import type { Created, Values } from 'fleet-protocol/tau'
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
}

export class TauService {
  /** Each session's last operation, which its next one waits for. */
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly runs: TauRuns,
    private readonly sessions: Sessions,
    private readonly log: (message: string) => void,
  ) {}

  /** Set up a box for a run of a tau, leave it stopped, and register the session (./runs.ts). */
  create(tauDir: string, values: Values, callerCwd: string): Promise<Created> {
    return this.runs.create(tauDir, values, callerCwd)
  }

  /**
   * Start a session's box, and its helper. The first start then makes the
   * dsh session and gives it its prompt, which a start that failed on the
   * way does again, without making or prompting twice.
   */
  async start(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      const entry = await this.runs.entry(sessionId)
      await this.runs.start(sessionId)
      if (entry.promptedAt !== undefined) return
      await this.sessions.create(sessionId, entry.project, basename(entry.tauDir))
      await this.sessions.prompt(sessionId, entry.promptRequestId, entry.prompt)
      await this.runs.prompted(sessionId)
      this.log(`started ${sessionId} in ${entry.project}, and gave it its prompt`)
    })
  }

  /** Cancel a session's turn, and stop its box, which keeps what is in it. */
  async stop(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      const entry = await this.runs.entry(sessionId)
      if (entry.promptedAt !== undefined) this.sessions.cancel(sessionId)
      await this.runs.stop(sessionId)
    })
  }

  /** Archive a session, remove its box, running or not, and forget the session. */
  async delete(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      const entry = await this.runs.entry(sessionId)
      await this.sessions.archive(sessionId)
      await this.runs.remove(sessionId)
      this.log(`deleted ${sessionId} and its box ${entry.box}`)
    })
  }

  /** Run a session's operations one after another, so that two starts make and prompt the session once. */
  private serial(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(sessionId) ?? Promise.resolve()).then(operation)
    const settled = next.catch(() => {})
    this.queues.set(sessionId, settled)
    void settled.then(() => { if (this.queues.get(sessionId) === settled) this.queues.delete(sessionId) })
    return next
  }
}
