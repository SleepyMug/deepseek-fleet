/**
 * fleet-tau, the tau service (./service.ts) on its socket, as tau's
 * `listenFleet` serves it to the host's `tau` command (./wire.ts), as
 * a dsh plugin: fleet-core's cordis.patch.yml mounts it in the profile it
 * is installed in. It builds on the runs of taus and their boxes,
 * `ctx.fleetTauRuns` (./runs-plugin.ts), and on dsh's session controller
 * and workspace registry, as the web client's own calls do, so that the web
 * UI lists a tau's session, under the caller's folder, and follows it, and
 * gives it dsh's full-access permission preset, since its box is its own;
 * on dsh's agents, to learn when a run's agent is done, and while it runs,
 * when it occupies its box; and on the workspace registry's writes, to
 * follow which sessions are archived, whose runs have no box. It imports
 * only their types.
 * Its config names the dsh home, where it serves its socket. It provides the
 * service as `ctx.fleetTau`, for the `tau` API's extension (fleet-ext-tau),
 * through which a tau's session submits runs from its box, and for
 * `tau_run` (../tools/tau.ts), with which another session submits them.
 * @module @sleepymug/fleet-core/tau/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import { listenFleet } from '@sleepymug/tau/adaptors'
import { fleetPaths } from '../paths.ts'
import { systemPlatform } from '../platform.ts'
import type {} from '../services.ts'
import { abortable } from '../util/abort.ts'
import { messageOf } from '../util/error.ts'
import { summarize } from './outcome.ts'
import { HOST } from './runs.ts'
import { TauService, type Sessions } from './service.ts'

export const name = 'fleet-tau'
export const inject = ['fleetTauRuns', 'sessionController', 'workspaceRegistry', 'agents']

/** The agent preset a tau's session has, which fleet-core's cordis.patch.yml declares. */
export const PRESET = 'tau'

/** The permission preset of a tau's session, dsh's own: no sandbox, and approval `never`. */
const FULL_ACCESS = 'danger-full-access'

/** For a prompt, which goes through once sent, whoever waits for it. */
const UNCANCELLED = new AbortController().signal

export interface Config {
  /** The dsh home, absolute. */
  dshHome: string
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const paths = fleetPaths(config?.dshHome, name)
  const platform = systemPlatform()
  const service = new TauService({ runs: ctx.fleetTauRuns, sessions: sessions(ctx, platform.log), platform })
  // The socket first: a service that does not get it, as when another serves this dsh home, watches no runs.
  const closeSocket = await listenFleet(paths.socket, service.handlerFor(HOST))
  const close = async (): Promise<void> => {
    await closeSocket()
    await service.close()
  }
  try {
    await service.load()
    ctx.effect(() => close, 'fleet-tau socket')
    ctx.provide('fleetTau', service)
    followArchive(ctx, service, platform.log)
    followTurns(ctx)
  } catch (error) {
    // Unloaded while it started, so nothing else would close the socket.
    await close()
    throw error
  }
}

/**
 * Tell the service which sessions dsh has archived, now and on each change.
 * Archiving has no event of its own, but every archive and unarchive
 * rewrites the workspace registry's state, and the write carries the whole
 * new list; the registry's own getter lags until the write returns.
 */
function followArchive(ctx: Context, service: TauService, log: (message: string) => void): void {
  let archived = new Set<string>(ctx.workspaceRegistry.archivedSessionIds)
  const follow = (): void => {
    service.followArchive(archived).catch((error: unknown) => {
      log(`could not follow the archived sessions: ${messageOf(error)}`)
    })
  }
  ctx.on('domain/changed', (change: DomainChanged) => {
    if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return
    const ids = (change.value as { archivedSessionIds?: unknown } | null)?.archivedSessionIds
    if (!Array.isArray(ids)) return
    const next = new Set(ids.map(String))
    if (next.size === archived.size && [...next].every(id => archived.has(id))) return
    archived = next
    follow()
  })
  follow()
}

/**
 * A tau's session's agent occupies its box while it runs, as a turn, so the
 * box is not stopped for being idle under it: from when it enters `running`,
 * which it does as it is woken, before its first step reaches the box, until
 * it leaves it, or goes.
 */
function followTurns(ctx: Context): void {
  const turns = new Map<string, () => void>()
  const settle = (agentId: string): void => {
    turns.get(agentId)?.()
    turns.delete(agentId)
  }
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'running') {
      settle(agent.id)
      return
    }
    const sessionId = agent.session.header.id
    if (turns.has(agent.id) || !ctx.fleetTauRuns.isTau(sessionId)) return
    turns.set(agent.id, ctx.fleetTauRuns.occupy(sessionId, { kind: 'turn', id: agent.id }))
  })
  ctx.on('agent/disposed', ({ agent }) => { settle(agent.id) })
  ctx.effect(() => () => {
    for (const release of turns.values()) release()
    turns.clear()
  }, 'fleet-tau turns')
}

/** dsh's sessions, as the service uses them. */
function sessions(ctx: Context, log: (message: string) => void): Sessions {
  return {
    async create(sessionId, project, title) {
      // The same folder's workspace each time, which the session controller attaches the session to.
      const workspace = await ctx.workspaceRegistry.create(project)
      await ctx.sessionController.create({ sessionId: sessionId as SessionId, workspaceId: workspace.id, agentPreset: PRESET })
      // Full access, and nothing asks a person: the box is the session's own, and its tools go nowhere else.
      const agent = ctx.agents.get(sessionId as SessionId)
      if (agent !== undefined) ctx.get('permissionPresets')?.set(agent.session, FULL_ACCESS)
      // A title only helps people find the session in the web UI; the session goes on without it.
      await ctx.sessionController.rename({ sessionId: sessionId as SessionId, title }).catch((error: unknown) => {
        log(`could not title ${sessionId}: ${messageOf(error)}`)
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
    async settled(sessionId, signal) {
      // An accepted prompt has woken the agent already, so idle means it is done with it.
      const agent = ctx.agents.get(sessionId as SessionId)
      if (agent !== undefined) await abortable(agent.whenIdle(), signal)
      const { events } = await ctx.sessionController.inspect(sessionId as SessionId, signal)
      return summarize(events)
    },
    async history(sessionId, signal) {
      return [...(await ctx.sessionController.inspect(sessionId as SessionId, signal)).events]
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
