/**
 * fleet-tau-runs, the runs of taus and their boxes (./runs.ts), as a dsh
 * plugin that provides them as `ctx.fleetTauRuns`, for fleet-core's world
 * (../world/) and the tau service (./plugin.ts). It needs only the
 * extensions provided, `ctx.fleetExts` (../ext/plugin.ts), which link a
 * run's APIs, and nothing of dsh's, so it loads before dsh's session
 * controller, which needs the world's `ctx.fs`. Its config names the dsh home, where it keeps the registry; its
 * boxes are Docker's; and it prints what it does on dsh's stderr. As it
 * unloads, when dsh exits, it stops the boxes it started.
 * @module fleet-core/tau/runs-plugin
 */

import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../ext/plugin.ts'
import { Registry } from './registry.ts'
import { TauRuns } from './runs.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetTauRuns: TauRuns
  }
}

export const name = 'fleet-tau-runs'
export const inject = ['fleetExts']

export interface Config {
  /** The dsh home, absolute. */
  dshHome: string
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (typeof config?.dshHome !== 'string' || !isAbsolute(config.dshHome)) {
    throw new Error('fleet-tau-runs: its config names dshHome, the dsh home, an absolute path')
  }
  const runs = new TauRuns(new Registry(join(config.dshHome, 'fleet', 'taus')), ctx.fleetExts, print)
  await runs.load()
  ctx.provide('fleetTauRuns', runs)
  ctx.effect(() => () => runs.close(), 'fleet-tau boxes')
}

/** On dsh's stderr, beside its own `dsh:` lines: its logger shows no info. */
export function print(message: string): void {
  process.stderr.write(`fleet-tau: ${message}\n`)
}
