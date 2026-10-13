/**
 * fleet-tau-runs, the runs of taus and their boxes (./runs.ts), as a dsh
 * plugin that provides them as `ctx.fleetTauRuns`, for fleet-core's world
 * (../world/) and the tau service (./plugin.ts). It needs only the
 * extensions provided, `ctx.fleetExts` (../ext/plugin.ts), which link a
 * run's APIs, and nothing of dsh's, so it loads before dsh's session
 * controller, which needs the world's `ctx.fs`. Its config names the dsh
 * home, where it keeps the registry; its boxes are Docker's; and it prints
 * what it does on dsh's stderr (../platform.ts). A box
 * nothing occupies is stopped after `idleStopMs`. As it unloads, when dsh
 * exits, it stops the boxes it started.
 * @module @sleepymug/fleet-core/tau/runs-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { fleetPaths } from '../paths.ts'
import { systemPlatform } from '../platform.ts'
import type {} from '../services.ts'
import { Registry } from './registry.ts'
import { TauRuns } from './runs.ts'

export const name = 'fleet-tau-runs'
export const inject = ['fleetExts']

export interface Config {
  /** The dsh home, absolute. */
  dshHome: string
  /** How long a box nothing occupies runs before it is stopped, in milliseconds; 60 s by default. */
  idleStopMs?: number
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const paths = fleetPaths(config?.dshHome, name)
  const { idleStopMs = 60_000 } = config
  if (typeof idleStopMs !== 'number' || !Number.isFinite(idleStopMs) || idleStopMs < 0) {
    throw new Error('fleet-tau-runs: idleStopMs, if given, is a number of milliseconds, 0 or more')
  }
  const runs = new TauRuns({ registry: new Registry(paths.taus), exts: ctx.fleetExts, platform: systemPlatform(), idleStopMs })
  await runs.load()
  ctx.provide('fleetTauRuns', runs)
  ctx.effect(() => () => runs.close(), 'fleet-tau boxes')
}
