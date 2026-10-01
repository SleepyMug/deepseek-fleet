/**
 * The fleet host's session operations behind its control socket. Each one
 * goes through dsh's session controller, as the web client's own calls do,
 * so a session the `fleet` command starts is one the web UI lists, follows
 * and can steer; a human message queued there while a run waits becomes
 * part of that run. A run of an agent directory has fleet-tau read and store
 * the agent before its session exists (../tau/store.ts), so every agent of
 * the session gets the agent's customization from the first step on.
 * Waiting follows dsh's headless runner: the agent is idle once no turn runs
 * and none is queued, and the outcome is the last turn's end and the last
 * assistant text.
 * @module fleet-core/control/control
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { realpathNormalize, WorkspaceActiveSessionError, WorkspaceUnknownSessionError, type WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { declarations, implementations } from 'fleet-image/apis/registry'
import type { Outcome, Request, Results } from 'fleet-protocol/control'
import type {} from '../box/world.ts'
import type {} from '../tau/backends.ts'
import { promptSpec } from '../tau/spec.ts'
import { InputError, type Spec } from '../tau/store.ts'
import { lastTurnStart, summarize } from './outcome.ts'

type RequestOf<K extends Request['op']> = Extract<Request, { op: K }>

/** For work that must go through once begun, whoever waits for it. */
const UNCANCELLED = new AbortController().signal

/** A failure the protocol reports with its own code. */
export class ControlError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export class FleetControl {
  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  /**
   * Start a session in a project, a folder registered as a dsh workspace,
   * which the web UI lists it under, and give it its task: a prompt, which
   * works in the project, or an agent directory, which is read first, so one
   * with problems is refused before anything exists, and which belongs to the
   * project and nothing more (../tau/store.ts).
   * @param started - told the session once its task is accepted, so its turn can be cancelled, before the wait.
   */
  async run(request: RequestOf<'run'>, signal: AbortSignal, started: (session: string) => void): Promise<Results['run']> {
    const project = await this.project(request.project)
    const { task } = request
    // What the session gets, its prompt included, and its title, which only an agent directory gives.
    let spec: Spec
    let title: string | undefined
    if ('prompt' in task) {
      spec = promptSpec(task.prompt)
    } else {
      if (!isAbsolute(task.agent) || !isAbsolute(task.callerCwd)) {
        throw new ControlError('fleet/bad-request', 'the agent directory and the command\'s folder must be absolute paths')
      }
      const prepared = await this.ctx.fleetTau.prepare({
        agent: task.agent, args: task.args, bind: true, callerCwd: task.callerCwd, env: task.env,
      })
      if (!prepared.ok) throw new ControlError('fleet/agent-invalid', `${task.agent} cannot run:\n  ${prepared.problems.join('\n  ')}`)
      spec = prepared.spec
      title = prepared.title
    }
    const workspace = await this.ctx.workspaceRegistry.create(project)
    const sessionId = await this.create(workspace.id, spec, signal).catch((error: unknown) => {
      if (error instanceof InputError && 'agent' in task) throw new ControlError('fleet/agent-invalid', `${task.agent} cannot run:\n  ${error.problems.join('\n  ')}`)
      throw error
    })
    try {
      if (title !== undefined) {
        // A title only helps people find the run in the web UI; the run goes on without it.
        await this.ctx.sessionController.rename({ sessionId, title }).catch((error: unknown) => {
          this.ctx.logger.warn(`fleet-control: could not title ${sessionId}: ${message(error)}`)
        })
      }
      // Once the session exists it gets its task even if the client has gone, which then only stops the wait.
      await this.prompt(sessionId, spec.prompt, UNCANCELLED)
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

  /**
   * Make a session in a workspace, its spec stored first under the id it
   * will have. A spec stays with a session that was made, even if creating
   * it failed later on, and goes with one that was not. A command that has
   * gone stops the spec from being stored, which can take a while for large
   * `in` paths.
   */
  private async create(workspaceId: WorkspaceId, spec: Spec, signal: AbortSignal): Promise<SessionId> {
    // The session controller's own format for new sessions.
    const sessionId = `session-${randomUUID()}` as SessionId
    await this.ctx.fleetTau.create(sessionId, spec, signal)
    try {
      await this.ctx.sessionController.create({ sessionId, workspaceId })
    } catch (error) {
      if (!await this.exists(sessionId, signal).catch(() => true)) {
        await this.ctx.fleetTau.remove(sessionId).catch((removeError: unknown) => {
          this.ctx.logger.warn(`fleet-control: could not remove the spec of ${sessionId}, which was never made: ${message(removeError)}`)
        })
      }
      throw error
    }
    return sessionId
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
          ...item.cwd === undefined ? {} : { project: item.cwd },
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
    const owner = await this.ctx.fleetBox.ownerHeaderOf(sessionId).catch(() => undefined)
    if (owner?.id !== sessionId) {
      throw new ControlError('fleet/subagent-session', owner === undefined
        ? `${sessionId} is a subagent session with no container of its own`
        : `${sessionId} is a subagent session, which uses the container of ${owner.id}; stop that one`)
    }
    const outcome = await this.ctx.fleetBox.stopSession(sessionId)
    return outcome.stopped ? { stopped: true } : { stopped: false, activity: [...new Set(outcome.occupants.map(occupant => occupant.kind))] }
  }

  /** Read an agent directory as a run would, and report every problem; nothing is made. */
  async check(request: RequestOf<'check'>): Promise<Results['check']> {
    if (!isAbsolute(request.agent) || !isAbsolute(request.callerCwd)) {
      throw new ControlError('fleet/bad-request', 'the agent directory and the command\'s folder must be absolute paths')
    }
    const prepared = await this.ctx.fleetTau.prepare({
      agent: request.agent, args: request.args, bind: request.bind, callerCwd: request.callerCwd, env: request.env,
    })
    return { problems: prepared.ok ? [] : prepared.problems }
  }

  apis(): Results['apis'] {
    const provided = this.ctx.fleetBackends.list()
    return {
      apis: implementations().map(implementation => ({
        name: implementation.name,
        ...implementation.description === undefined ? {} : { description: implementation.description },
        declarations: declarations(implementation),
        backends: [...implementation.backends],
        missing: implementation.backends.filter(backend => !provided.includes(backend)),
      })),
    }
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

  /** A run's project as dsh's workspaces have it, through symlinks, refused before anything is read when it cannot be one. */
  private async project(folder: string): Promise<string> {
    if (!isAbsolute(folder)) throw new ControlError('fleet/bad-request', `the project must be an absolute path: ${folder}`)
    return await realpathNormalize(folder).catch((error: unknown) => {
      throw new ControlError('fleet/bad-request', `the project ${folder} cannot be used: ${message(error)}`)
    })
  }

  private async prompt(sessionId: SessionId, text: string, signal: AbortSignal): Promise<void> {
    await this.ctx.sessionController.prompt({
      requestId: randomUUID() as SessionRequestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, signal)
  }

  /**
   * Wait until the session's agent, if one holds it, is idle, then read the
   * outcome from its log. After a completed turn, the agent's out paths
   * are published, once per turn, whoever waits (../tau/store.ts).
   * @param from - the first event the outcome covers, or the start of the last turn.
   */
  private async settle(sessionId: SessionId, from: number | 'last-turn', signal: AbortSignal): Promise<Outcome> {
    // An accepted prompt has already woken the agent, so idle means its work, and whatever it led to, is done.
    const agent = this.ctx.agents.get(sessionId)
    if (agent !== undefined) await abortable(agent.whenIdle(), signal)
    const { events } = await this.ctx.sessionController.inspect(sessionId, signal)
    const outcome = summarize(events, from === 'last-turn' ? lastTurnStart(events) : from)
    if (outcome.reason !== 'completed') return outcome
    const outputs = await this.ctx.fleetTau.publish(sessionId, events.findLastIndex(event => event.type === 'turn/end'))
      .catch((error: unknown) => [`could not publish the outputs: ${message(error)}`])
    return outputs.length === 0 ? outcome : { ...outcome, outputs }
  }

  private async known(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    if (!await this.exists(sessionId, signal)) throw new ControlError('session/not-found', `there is no session ${sessionId}`)
  }

  private async exists(sessionId: SessionId, signal: AbortSignal): Promise<boolean> {
    if (this.ctx.agents.get(sessionId) !== undefined) return true
    return await this.ctx.sessionPersistence.stat(sessionId, { signal }) !== undefined
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
