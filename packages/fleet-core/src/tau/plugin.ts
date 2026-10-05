/**
 * fleet-tau, the tau service (./service.ts) on its socket (./server.ts), as
 * a dsh plugin: fleet-core's cordis.patch.yml mounts it in the fleet
 * profile. It builds on the runs of taus and their boxes, `ctx.fleetTauRuns`
 * (./runs-plugin.ts), and on dsh's session controller and workspace
 * registry, as the web client's own calls do, so that the web UI lists a
 * tau's session, under the caller's folder, and follows it; and on dsh's
 * agents, to learn when a run's agent is done. It imports only their types.
 * Its config names the dsh home, where it serves its socket. It provides the
 * service as `ctx.fleetTau`, for the `tau` API's extension (fleet-ext-tau),
 * through which a tau's session starts runs from its box.
 * @module fleet-core/tau/plugin
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { socketPath } from 'fleet-protocol/tau'
import { summarize } from './outcome.ts'
import { print } from './runs-plugin.ts'
import { listen } from './server.ts'
import { TauService, abortable, type Sessions } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetTau: TauService
  }
}

export const name = 'fleet-tau'
export const inject = ['fleetTauRuns', 'sessionController', 'workspaceRegistry', 'agents']

/** The agent preset a tau's session has, which fleet-core's cordis.patch.yml declares. */
export const PRESET = 'tau'

/** For a prompt, which goes through once sent, whoever waits for it. */
const UNCANCELLED = new AbortController().signal

export interface Config {
  /** The dsh home, absolute. */
  dshHome: string
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (typeof config?.dshHome !== 'string' || !isAbsolute(config.dshHome)) {
    throw new Error('fleet-tau: its config names dshHome, the dsh home, an absolute path')
  }
  const service = new TauService(ctx.fleetTauRuns, sessions(ctx), print)
  // The socket first: a service that does not get it, as when another serves this dsh home, watches no runs.
  const closeSocket = await listen(socketPath(config.dshHome), service)
  const close = async (): Promise<void> => {
    await closeSocket()
    await service.close()
  }
  try {
    await service.load()
    ctx.effect(() => close, 'fleet-tau socket')
    ctx.provide('fleetTau', service)
  } catch (error) {
    // Unloaded while it started, so nothing else would close the socket.
    await close()
    throw error
  }
}

/** dsh's sessions, as the service uses them. */
function sessions(ctx: Context): Sessions {
  return {
    async create(sessionId, project, title) {
      // The same folder's workspace each time, which the session controller attaches the session to.
      const workspace = await ctx.workspaceRegistry.create(project)
      await ctx.sessionController.create({ sessionId: sessionId as SessionId, workspaceId: workspace.id, agentPreset: PRESET })
      // A title only helps people find the session in the web UI; the session goes on without it.
      await ctx.sessionController.rename({ sessionId: sessionId as SessionId, title }).catch((error: unknown) => {
        print(`could not title ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      })
    },
    async prompt(sessionId, requestId, text) {
      await ctx.sessionController.prompt({
        requestId: requestId as SessionRequestId,
        sessionId: sessionId as SessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, UNCANCELLED)
    },
    cancel(sessionId) {
      ctx.sessionController.cancel({ sessionId: sessionId as SessionId })
    },
    async settled(sessionId, signal) {
      // An accepted prompt has woken the agent already, so idle means it is done with it.
      const agent = ctx.agents.get(sessionId as SessionId)
      if (agent !== undefined) await abortable(agent.whenIdle(), signal)
      const { events } = await ctx.sessionController.inspect(sessionId as SessionId, signal)
      return summarize(events)
    },
    async archive(sessionId) {
      try {
        await ctx.workspaceRegistry.archiveSession(sessionId as SessionId, { stopActivity: true })
      } catch (error) {
        // A session whose first start never made it.
        if (error instanceof Error && error.name === 'WorkspaceUnknownSessionError') return
        throw error
      }
    },
  }
}
