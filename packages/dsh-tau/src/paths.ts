/**
 * Where dsh-tau keeps what it keeps, in the dsh home: each plugin's config
 * names the home, and takes its places from here.
 * @module @sleepymug/dsh-tau/paths
 */

import { isAbsolute, join, resolve } from 'node:path'

export interface TauPaths {
  /** The dsh home, absolute. */
  home: string
  /** dsh-tau's own folder in it. */
  tau: string
  /** The registry of the runs of taus, with a folder for each. */
  runs: string
  /** dsh's attachment store. */
  attachments: string
}

/**
 * The places in a dsh home, as a plugin's config names it.
 * @param plugin - the plugin whose config it is, which a mistaken one names.
 */
export function tauPaths(dshHome: unknown, plugin: string): TauPaths {
  if (typeof dshHome !== 'string' || !isAbsolute(dshHome)) throw new Error(`${plugin}: its config names dshHome, the dsh home, an absolute path`)
  const home = resolve(dshHome)
  const tau = join(home, 'tau')
  return { home, tau, runs: join(tau, 'runs'), attachments: join(home, 'attachments') }
}
