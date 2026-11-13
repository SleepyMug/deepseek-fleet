/**
 * The environment of each process the helper starts: the helper's own, with
 * the box's services' (./services.ts), and what the gateway gives the process,
 * a name given `null` removed; and, whatever the gateway gives, the services'
 * commands on its PATH, first, since a harness may pass a PATH of its own.
 * @module @sleepymug/fleet-box/helper/cmd/env
 */

import { BIN_DIR } from '@sleepymug/fleet-protocol/layout'

/** The environment the helper runs in, as each process starts from it. */
export type Environment = Readonly<Record<string, string | undefined>>

/** A process's environment: `base`, then `given`, a name given `null` removed, with `bin` on its PATH. */
export function environment(base: Environment, given: Readonly<Record<string, string | null>>, bin = binOf(base)): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) merged[key] = value
  for (const [key, value] of Object.entries(given)) {
    if (value === null) Reflect.deleteProperty(merged, key)
    else merged[key] = value
  }
  merged.PATH = withBin(merged, bin)
  return merged
}

/** The PATH of `env`, with `bin` first, once. */
export function withBin(env: Environment, bin = BIN_DIR): string {
  const rest = (env.PATH ?? '').split(':').filter(folder => folder !== '' && folder !== bin)
  return [bin, ...rest].join(':')
}

/** The folder of commands the helper's own PATH starts with, as the services put it there; the box's otherwise. */
function binOf(base: Environment): string {
  return (base.PATH ?? '').split(':')[0] || BIN_DIR
}
