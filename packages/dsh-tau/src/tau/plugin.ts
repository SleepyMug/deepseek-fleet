/**
 * fleet-tau, the tau backend (./service.ts), as a dsh plugin: dsh-tau's
 * cordis.patch.yml mounts it in the profile it is installed in. It puts the
 * backend together from the runs of taus and their boxes, `ctx.fleetTauRuns`
 * (./runs-plugin.ts), and dsh's sessions (../dsh/sessions.ts), made with the
 * `tau` agent preset; serves it on its socket in the dsh home, as tau's
 * `listenSocket` does, for the host's `tau --adaptor socket`; registers its
 * tau service with the fleet host, whose package, dsh-tau-box, puts the
 * `tau` command in every box, its runs those of the run the box is, through
 * the service's connections, which the host relays; and has it follow which
 * sessions dsh archives, whose runs have no box (../dsh/archive.ts), and a
 * tau's session's agent occupy its box while it runs (../dsh/turns.ts). Its
 * config names the dsh home, where it serves its socket. It provides the
 * backend as `ctx.fleetTau`, for `tau_run` (../tools/tau.ts), with which
 * another session submits runs.
 * @module @sleepymug/dsh-tau/tau/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { listenSocket } from '@sleepymug/tau/adaptors'
import { followArchived } from '../dsh/archive.ts'
import { dshSessions } from '../dsh/sessions.ts'
import { followTurns } from '../dsh/turns.ts'
import { tauPaths } from '../paths.ts'
import { systemPlatform } from '../platform.ts'
import type {} from '../services.ts'
import { messageOf } from '../util/error.ts'
import { tauService } from './box-service.ts'
import { HOST } from './registry.ts'
import { TauService } from './service.ts'

export const name = 'fleet-tau'
export const inject = ['fleetTauRuns', 'fleetClient', 'sessionController', 'workspaceRegistry', 'agents']

/** The agent preset a tau's session has, which dsh-tau's cordis.patch.yml declares. */
export const PRESET = 'tau'

export interface Config {
  /** The dsh home, absolute. */
  dshHome: string
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const paths = tauPaths(config?.dshHome, name)
  const platform = systemPlatform()
  const runs = ctx.fleetTauRuns
  const service = new TauService({ runs, sessions: dshSessions(ctx, { preset: PRESET, log: platform.log }), platform })
  // The tau service first, whose package every run's box sets itself up with.
  const registration = await ctx.fleetClient.register(tauService(box => runs.sessionOfBox(box), caller => service.handlerFor(caller)))
  ctx.effect(() => () => registration.unregister(), 'fleet-tau service')
  // Then the socket: a backend that does not get it, as when another serves this dsh home, watches no runs.
  const closeSocket = await listenSocket(paths.socket, service.handlerFor(HOST))
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
