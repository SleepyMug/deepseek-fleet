/**
 * dsh's sessions, as the tau service uses them (../tau/service.ts):
 * through dsh's session controller and workspace registry, as the web
 * client's own calls go, so that the web UI lists a tau's session, under
 * the caller's folder, and follows it; with dsh's full-access permission
 * preset, since its box is its own; and through dsh's agents, to learn when
 * a session's agent is done with its prompt, and how its run ended
 * (./outcome.ts). It imports only dsh's types.
 * @module @sleepymug/fleet-core/dsh/sessions
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Sessions } from '../tau/service.ts'
import { abortable } from '../util/abort.ts'
import { messageOf } from '../util/error.ts'
import { resultOf, summarize } from './outcome.ts'

/** The permission preset of a tau's session, dsh's own: no sandbox, and approval `never`. */
const FULL_ACCESS = 'danger-full-access'

/** For a prompt, which goes through once sent, whoever waits for it. */
const UNCANCELLED = new AbortController().signal

/** What of dsh's the sessions are made through: its services, and `get`, for the permission presets, which a profile may not have. */
export type DshSessionsDeps = Pick<Context, 'workspaceRegistry' | 'sessionController' | 'agents' | 'get'>

export interface DshSessionsOptions {
  /** The agent preset a tau's session is made with. */
  preset: string
  log: (message: string) => void
}

export function dshSessions(dsh: DshSessionsDeps, { preset, log }: DshSessionsOptions): Sessions {
  return {
    async create(sessionId, project, title) {
      // The same folder's workspace each time, which the session controller attaches the session to.
      const workspace = await dsh.workspaceRegistry.create(project)
      await dsh.sessionController.create({ sessionId: sessionId as SessionId, workspaceId: workspace.id, agentPreset: preset })
      // Full access, and nothing asks a person: the box is the session's own, and its tools go nowhere else.
      const agent = dsh.agents.get(sessionId as SessionId)
      if (agent !== undefined) dsh.get('permissionPresets')?.set(agent.session, FULL_ACCESS)
      // A title only helps people find the session in the web UI; the session goes on without it.
      await dsh.sessionController.rename({ sessionId: sessionId as SessionId, title }).catch((error: unknown) => {
        log(`could not title ${sessionId}: ${messageOf(error)}`)
      })
    },
    async prompt(sessionId, requestId, text) {
      await dsh.sessionController.prompt({
        requestId: requestId as SessionRequestId,
        sessionId: sessionId as SessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, UNCANCELLED)
    },
    async settled(sessionId, signal) {
      // An accepted prompt has woken the agent already, so idle means it is done with it.
      const agent = dsh.agents.get(sessionId as SessionId)
      if (agent !== undefined) await abortable(agent.whenIdle(), signal)
      const { events } = await dsh.sessionController.inspect(sessionId as SessionId, signal)
      return resultOf(summarize(events))
    },
    async history(sessionId, signal) {
      return [...(await dsh.sessionController.inspect(sessionId as SessionId, signal)).events]
    },
    async stop(sessionId) {
      // The user's own stop, as the chat box's; a session not at work here has none to stop.
      const agent = dsh.agents.get(sessionId as SessionId)
      if (agent === undefined) return
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
    },
    async archive(sessionId) {
      try {
        await dsh.workspaceRegistry.archiveSession(sessionId as SessionId, { stopActivity: true })
      } catch (error) {
        // A session whose first start never made it.
        if (error instanceof Error && error.name === 'WorkspaceUnknownSessionError') return
        throw error
      }
    },
  }
}
