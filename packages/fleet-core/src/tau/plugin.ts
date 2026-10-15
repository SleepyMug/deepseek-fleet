/**
 * fleet-tau, the tau service (./service.ts) on its socket, as tau's
 * `listenFleet` serves it to the host's `tau` command (./wire.ts), as
 * a dsh plugin: fleet-core's cordis.patch.yml mounts it in the profile it
 * is installed in. It puts the service together from the runs of taus and
 * their boxes, `ctx.fleetTauRuns` (./runs-plugin.ts), and dsh's sessions
 * (../dsh/sessions.ts), made with the `tau` agent preset; and has it follow
 * which sessions dsh archives, whose runs have no box (../dsh/archive.ts),
 * and a tau's session's agent occupy its box while it runs
 * (../dsh/turns.ts). Its config names the dsh home, where it serves its
 * socket, and whether a run's release keeps its session, which a change
 * reaches at the next release, nothing mounted again. It provides the service as `ctx.fleetTau`, for the `tau` API's
 * extension (fleet-ext-tau), through which a tau's session submits runs
 * from its box, and for `tau_run` (../tools/tau.ts), with which another
 * session submits them.
 * @module @sleepymug/fleet-core/tau/plugin
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { listenFleet } from '@sleepymug/tau/adaptors'
import { followArchived } from '../dsh/archive.ts'
import { dshSessions } from '../dsh/sessions.ts'
import { followTurns } from '../dsh/turns.ts'
import { fleetPaths } from '../paths.ts'
import { systemPlatform } from '../platform.ts'
import type {} from '../services.ts'
import { messageOf } from '../util/error.ts'
import { HOST } from './registry.ts'
import { TauService } from './service.ts'

export const name = 'fleet-tau'
export const inject = ['fleetTauRuns', 'sessionController', 'workspaceRegistry', 'agents']

/** The agent preset a tau's session has, which fleet-core's cordis.patch.yml declares. */
export const PRESET = 'tau'

export interface Config {
  /** The dsh home, absolute. */
  dshHome: string
  /**
   * Whether a run's release keeps its session in its workspace, with its
   * box, for a person to go on with, rather than archive it and remove its
   * box; false by default.
   */
  keepSessions: Volatile<boolean>
}

export const Config = z.object({
  dshHome: z.string(),
  keepSessions: z.boolean().default(false).volatile(),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  const paths = fleetPaths(config?.dshHome, name)
  const platform = systemPlatform()
  const runs = ctx.fleetTauRuns
  const service = new TauService({
    runs,
    sessions: dshSessions(ctx, { preset: PRESET, log: platform.log }),
    platform,
    keepSessions: () => config.keepSessions.get(),
  })
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
    followArchived(ctx, (archived) => {
      service.followArchive(archived).catch((error: unknown) => {
        platform.log(`could not follow the archived sessions: ${messageOf(error)}`)
      })
    })
    followTurns(ctx, runs)
  } catch (error) {
    // Unloaded while it started, so nothing else would close the socket.
    await close()
    throw error
  }
}
