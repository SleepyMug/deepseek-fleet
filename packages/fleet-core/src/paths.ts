/**
 * Where the fleet host keeps what it keeps, in the dsh home: each plugin's
 * config names the home, and takes its places from here.
 * @module @sleepymug/fleet-core/paths
 */

import { isAbsolute, join, resolve } from 'node:path'
import { socketPath } from '@sleepymug/fleet-protocol/tau'

export interface FleetPaths {
  /** The dsh home, absolute. */
  home: string
  /** Fleet's own folder in it, where an extension keeps what it keeps, in a folder of its own. */
  fleet: string
  /** The registry of the runs of taus, with a folder for each. */
  taus: string
  /** The tau service's socket. */
  socket: string
  /** dsh's attachment store. */
  attachments: string
}

/**
 * The places in a dsh home, as a plugin's config names it.
 * @param plugin - the plugin whose config it is, which a mistaken one names.
 */
export function fleetPaths(dshHome: unknown, plugin: string): FleetPaths {
  if (typeof dshHome !== 'string' || !isAbsolute(dshHome)) throw new Error(`${plugin}: its config names dshHome, the dsh home, an absolute path`)
  const home = resolve(dshHome)
  const fleet = join(home, 'fleet')
  return { home, fleet, taus: join(fleet, 'taus'), socket: socketPath(home), attachments: join(home, 'attachments') }
}
