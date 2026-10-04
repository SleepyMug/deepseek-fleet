/**
 * fleet-tau, the tau service (./service.ts) on its socket (./server.ts), as
 * a dsh plugin: fleet-core's cordis.patch.yml mounts it in the fleet
 * profile. Its config names the dsh home, where it serves its socket and
 * keeps its registry; its boxes are Docker's; and it prints what it does on
 * dsh's stderr. Of dsh's, it uses the session controller and the workspace
 * registry, as the web client's own calls do, so that the web UI lists a
 * tau's session, under the caller's folder, and follows it. It imports only
 * their types.
 * @module fleet-core/tau/plugin
 */

import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { socketPath } from 'fleet-protocol/tau'
import { Registry } from './registry.ts'
import { listen } from './server.ts'
import { TauService, type Sessions } from './service.ts'

export const name = 'fleet-tau'
export const inject = ['sessionController', 'workspaceRegistry']

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
  // On dsh's stderr, beside its own `dsh:` lines: its logger shows no info.
  const print = (message: string): void => { process.stderr.write(`fleet-tau: ${message}\n`) }
  const service = new TauService(new Registry(join(config.dshHome, 'fleet', 'taus')), print, sessions(ctx, print))
  const close = await listen(socketPath(config.dshHome), service)
  try {
    ctx.effect(() => async () => {
      await close()
      await service.close()
    }, 'fleet-tau socket')
  } catch (error) {
    // Unloaded while it started, so nothing else would close the socket.
    await close()
    throw error
  }
}

/** dsh's sessions, as the service uses them. */
function sessions(ctx: Context, print: (message: string) => void): Sessions {
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
