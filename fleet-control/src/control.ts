/**
 * The fleet host's session operations behind its control socket. Each one
 * goes through dsh's session controller, as the web client's own calls do,
 * so a session the `fleet` command starts is one the web UI lists, follows
 * and can steer; a human message queued there while a run waits becomes
 * part of that run. Waiting follows dsh's headless runner: the agent is idle
 * once no turn runs and none is queued, and the outcome is the last turn's
 * end and the last assistant text.
 * @module fleet-control/control
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { WorkspaceActiveSessionError, WorkspaceUnknownSessionError } from '@deepseek-ai/dsh-workspace'
import type {} from 'fleet-box/world'
import { lastTurnStart, openTurnStart, summarize } from './outcome.ts'
import type { Outcome, Request, Results } from './protocol.ts'

type RequestOf<K extends Request['op']> = Extract<Request, { op: K }>

/** For work that must go through once begun, whoever waits for it. */
const UNCANCELLED = new AbortController().signal

/** A failure the protocol reports with its own code. */
export class ControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export class FleetControl {
  constructor(private readonly ctx: Context) {}

  /**
   * Start a session in a folder, registered as a workspace so the web UI
   * lists it there, and give it its task.
   * @param started - told the session once its task is accepted, so its turn can be cancelled, before the wait.
   */
  async run(request: RequestOf<'run'>, signal: AbortSignal, started: (session: string) => void): Promise<Results['run']> {
    if (!isAbsolute(request.cwd)) throw new ControlError('fleet/bad-request', `the folder must be an absolute path: ${request.cwd}`)
    const workspace = await this.ctx.workspaceRegistry.create(request.cwd)
    const { sessionId } = await this.ctx.sessionController.create({ workspaceId: workspace.id })
    try {
      if (request.title !== undefined && request.title.trim() !== '') {
        // A title only helps people find the run in the web UI; the run goes on without it.
        await this.ctx.sessionController.rename({ sessionId, title: request.title }).catch((error: unknown) => {
          this.ctx.logger.warn(`fleet-control: could not title ${sessionId}: ${message(error)}`)
        })
      }
      // Once the session exists it gets its task even if the client has gone, which then only stops the wait.
      await this.prompt(sessionId, request.prompt, 'queue', UNCANCELLED)
    } catch (error) {
      // Without its task the session would sit empty in the web UI, and the client never learns it.
      await this.ctx.workspaceRegistry.archiveSession(sessionId).catch((archiveError: unknown) => {
        this.ctx.logger.warn(`fleet-control: could not archive ${sessionId}, which has no task: ${message(archiveError)}`)
      })
      throw error
    }
    started(sessionId)
    if (!request.wait) return { session: sessionId }
    return { session: sessionId, outcome: await this.settle(sessionId, 0, signal) }
  }

  /** Send a message to a session, a later turn or steering for the running one. */
  async send(request: RequestOf<'send'>, signal: AbortSignal): Promise<Results['send']> {
    const sessionId = request.session as SessionId
    // The message leads to what the session logs from now on, and joins a turn already open.
    const from = openTurnStart((await this.ctx.sessionController.inspect(sessionId, signal)).events)
    await this.prompt(sessionId, request.prompt, request.steer ? 'steer' : 'queue', signal)
    if (!request.wait) return {}
    return { outcome: await this.settle(sessionId, from, signal) }
  }

  /** Wait until a session is idle and report its last turn; a session no agent holds is only read. */
  async wait(request: RequestOf<'wait'>, signal: AbortSignal): Promise<Results['wait']> {
    return { outcome: await this.settle(request.session as SessionId, 'last-turn', signal) }
  }

  async list(signal: AbortSignal): Promise<Results['list']> {
    const { items } = await this.ctx.sessionController.list({}, signal)
    const archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds)
    return {
      sessions: items.filter(item => item.origin !== 'subagent' && !archived.has(item.sessionId)).map((item) => {
        const title = item.projections?.values.title
        return {
          session: item.sessionId,
          ...typeof title === 'string' ? { title } : {},
          ...item.cwd === undefined ? {} : { cwd: item.cwd },
          running: item.running,
          updatedAt: item.updatedAt,
        }
      }),
    }
  }

  cancel(request: RequestOf<'cancel'>): Results['cancel'] {
    this.ctx.sessionController.cancel({ sessionId: request.session as SessionId })
    return {}
  }

  /** Stop a session's container now, which its next use starts again, unless something occupies it. */
  async stop(request: RequestOf<'stop'>, signal: AbortSignal): Promise<Results['stop']> {
    const sessionId = request.session as SessionId
    await this.known(sessionId, signal)
    const header = this.ctx.sessions.get(sessionId)?.header
    if (header?.origin === 'subagent') {
      throw new ControlError('fleet/subagent-session', `${sessionId} is a subagent session, which shares the container of ${header.parentSession ?? 'its root'}; stop that one`)
    }
    const outcome = await this.ctx.fleetBox.stopSession(sessionId)
    return outcome.stopped ? { stopped: true } : { stopped: false, activity: [...new Set(outcome.occupants.map(occupant => occupant.kind))] }
  }

  /** Archive a session; fleet-box removes its container. */
  async archive(request: RequestOf<'archive'>): Promise<Results['archive']> {
    try {
      await this.ctx.workspaceRegistry.archiveSession(request.session as SessionId, { stopActivity: request.force })
    } catch (error) {
      if (error instanceof WorkspaceUnknownSessionError) throw new ControlError('session/not-found', `there is no session ${request.session}`)
      if (!(error instanceof WorkspaceActiveSessionError)) throw error
      throw new ControlError('fleet/session-active',
        `${request.session} is still running (${error.activity.map(activity => activity.kind).join(', ')}); cancel it first, or force the archive`)
    }
    return {}
  }

  private async prompt(sessionId: SessionId, text: string, mode: 'queue' | 'steer', signal: AbortSignal): Promise<void> {
    await this.ctx.sessionController.prompt({
      requestId: randomUUID() as SessionRequestId,
      sessionId,
      mode,
      content: [{ type: 'text', text }],
    }, signal)
  }

  /**
   * Wait until the session's agent, if one holds it, is idle, then read the outcome from its log.
   * @param from - the first event the outcome covers, or the start of the last turn.
   */
  private async settle(sessionId: SessionId, from: number | 'last-turn', signal: AbortSignal): Promise<Outcome> {
    // An accepted prompt has already woken the agent, so idle means its work, and whatever it led to, is done.
    const agent = this.ctx.agents.get(sessionId)
    if (agent !== undefined) await abortable(agent.whenIdle(), signal)
    const { events } = await this.ctx.sessionController.inspect(sessionId, signal)
    return summarize(events, from === 'last-turn' ? lastTurnStart(events) : from)
  }

  private async known(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    if (this.ctx.agents.get(sessionId) !== undefined) return
    if (await this.ctx.sessionPersistence.stat(sessionId, { signal }) === undefined) {
      throw new ControlError('session/not-found', `there is no session ${sessionId}`)
    }
  }
}

/** Stop waiting for an operation when the signal aborts; the operation goes on. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', aborted) })
  })
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
