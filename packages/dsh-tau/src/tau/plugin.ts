/**
 * fleet-tau, the tau backend (./service.ts), as a dsh plugin: dsh-tau's
 * cordis.patch.yml mounts it in the profile it is installed in. It puts the
 * backend together from the runs of taus and their boxes, `ctx.fleetTauRuns`
 * (./runs-plugin.ts), and dsh's sessions (../dsh/sessions.ts), made with the
 * `tau` agent preset; serves it as the tau service through fleet's gateway
 * (./tau-service.ts), for a box's `tau` command, whose runs are those of the
 * run the box is, and the host's `tau` command, as a client of the gateway;
 * and has it follow which sessions dsh archives, whose runs have no box
 * (../dsh/archive.ts), and a tau's session's agent occupy its box while it
 * runs (../dsh/turns.ts). Its config names the dsh home. It provides the
 * backend as `ctx.fleetTau`, for `tau_run` (../tools/tau.ts), with which
 * another session submits runs.
 * @module @sleepymug/dsh-tau/tau/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { followArchived } from '../dsh/archive.ts'
import { dshSessions } from '../dsh/sessions.ts'
import { followTurns } from '../dsh/turns.ts'
import { tauPaths } from '../paths.ts'
import { systemPlatform } from '../platform.ts'
import type {} from '../services.ts'
import { messageOf } from '../util/error.ts'
import { TauService } from './service.ts'
import { tauService } from './tau-service.ts'

export const name = 'fleet-tau'
export const inject = ['fleetTauRuns', 'fleet', 'sessionController', 'workspaceRegistry', 'agents']

/** The agent preset a tau's session has, which dsh-tau's cordis.patch.yml declares. */
export const PRESET = 'tau'

export interface Config {
  /** The dsh home, absolute. */
  dshHome: string
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  tauPaths(config?.dshHome, name)
  const platform = systemPlatform()
  const runs = ctx.fleetTauRuns
  const service = new TauService({ runs, sessions: dshSessions(ctx, { preset: PRESET, log: platform.log }), platform })
  // The service first, whose package every run's box is made with; a backend whose service another serves watches no runs.
  const registration = await ctx.fleet.serve(tauService(box => runs.sessionOfBox(box), caller => service.backendFor(caller)))
  const close = async (): Promise<void> => {
    registration.close()
    await service.close()
  }
  try {
    await service.load()
    ctx.effect(() => close, 'fleet-tau service')
    ctx.provide('fleetTau', service)
    followArchived(ctx, (archived) => {
      service.followArchive(archived).catch((error: unknown) => {
        platform.log(`could not follow the archived sessions: ${messageOf(error)}`)
      })
    })
    followTurns(ctx, runs)
  } catch (error) {
    // Unloaded while it started, so nothing else would close the service.
    await close()
    throw error
  }
}
