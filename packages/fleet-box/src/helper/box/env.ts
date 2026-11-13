/**
 * The environment of each program the helper runs: the box's, its
 * services' with it, as the container has it, less what is the helper's
 * own; the box's services' commands first on its PATH, and the services'
 * socket named; then what the call adds, and less what it removes.
 * @module @sleepymug/fleet-box/helper/box/env
 */

import { GATEWAY_VARIABLE, ROOT_VARIABLE, SERVICES_SOCKET_VARIABLE, type BoxLayout } from '@sleepymug/fleet-protocol/layout'

export type Environment = Readonly<Record<string, string | undefined>>

/** What every program starts with: `base`, the helper's own, as the box's. */
export function boxEnvironment(base: Environment, layout: BoxLayout): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value
  // The helper's alone: a program reaches the gateway through the services' socket.
  delete env[GATEWAY_VARIABLE]
  delete env[ROOT_VARIABLE]
  env.PATH = withFirst(env.PATH, layout.bin)
  env[SERVICES_SOCKET_VARIABLE] = layout.servicesSocket
  return env
}

/** A program's environment: the box's, with `add`, less `unset`, the services' commands still first on its PATH. */
export function programEnvironment(box: Readonly<Record<string, string>>, add: Readonly<Record<string, string>>, unset: readonly string[], layout: BoxLayout): Record<string, string> {
  const env = { ...box, ...add }
  for (const name of unset) delete env[name]
  env.PATH = withFirst(env.PATH, layout.bin)
  return env
}

/** `path` with `first` first, once. */
function withFirst(path: string | undefined, first: string): string {
  return [first, ...(path ?? '').split(':').filter(folder => folder !== '' && folder !== first)].join(':')
}
