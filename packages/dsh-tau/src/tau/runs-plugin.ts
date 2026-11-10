/**
 * fleet-tau-runs, the runs of taus and their boxes (./runs.ts), as a dsh
 * plugin that provides them as `ctx.fleetTauRuns`, for dsh-tau's world
 * (../world/) and the tau backend (./plugin.ts). It builds on the fleet
 * host, which keeps the boxes, through its client, on the host's socket, and
 * nothing of dsh's, so it loads before dsh's session controller, which needs
 * the world's `ctx.fs`. Its config names the dsh home, where it keeps the
 * registry; and the fleet host's socket, the image of a run's box, and how
 * long a box nothing occupies runs before the host stops it, each the
 * host's own without it. It prints what it does on dsh's stderr
 * (../platform.ts). As it unloads, when dsh exits, it closes its client, so
 * the host lets each box stop once it is idle.
 * @module @sleepymug/dsh-tau/tau/runs-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { FleetClient } from '@sleepymug/fleet-client'
import { tauPaths } from '../paths.ts'
import { systemPlatform } from '../platform.ts'
import type {} from '../services.ts'
import { fleetOf } from './fleet.ts'
import { Registry } from './registry.ts'
import { TauRuns } from './runs.ts'

export const name = 'fleet-tau-runs'

export interface Config {
  /** The dsh home, absolute. */
  dshHome: string
  /** The fleet host's socket; `$FLEET_SOCKET`, or `fleet.sock` in the fleet home, by default. */
  fleetSocket?: string
  /** The image a run's box runs; the fleet host's default by default. */
  image?: string
  /** How long a box nothing occupies runs before it is stopped, in milliseconds; the fleet host's default by default. */
  idleStopMs?: number
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const paths = tauPaths(config?.dshHome, name)
  const { idleStopMs, image, fleetSocket } = config
  if (idleStopMs !== undefined && (typeof idleStopMs !== 'number' || !Number.isFinite(idleStopMs) || idleStopMs < 0)) {
    throw new Error(`${name}: idleStopMs, if given, is a number of milliseconds, 0 or more`)
  }
  if (image !== undefined && (typeof image !== 'string' || image === '')) throw new Error(`${name}: image, if given, is an image's name`)
  if (fleetSocket !== undefined && (typeof fleetSocket !== 'string' || fleetSocket === '')) throw new Error(`${name}: fleetSocket, if given, is a path`)
  const platform = systemPlatform()
  const client = await FleetClient.connect({ ...fleetSocket === undefined ? {} : { socket: fleetSocket }, log: platform.log })
  ctx.effect(() => () => client.close(), 'fleet client')
  const runs = new TauRuns({
    registry: new Registry(paths.runs),
    fleet: fleetOf(client),
    platform,
    ...idleStopMs === undefined ? {} : { idleStopMs },
    ...image === undefined ? {} : { image },
  })
  await runs.load()
  ctx.provide('fleetTauRuns', runs)
  ctx.provide('fleetClient', client)
  ctx.effect(() => () => { runs.close() }, 'fleet-tau boxes')
}
