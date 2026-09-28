/**
 * The variables of the command's environment that an agent directory asks
 * for: those its tau.json lists in `env`. A run sends only their values, so
 * the host never sees the rest of the caller's environment. The host reads
 * and checks tau.json itself; this reads only `env`, leniently, and a
 * tau.json it cannot read sends nothing, leaving the host to report it.
 * @module fleet-control/agent-env
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param dir - the agent directory.
 * @param env - the command's environment.
 * @returns the listed variables that are set, with their values.
 */
export function agentEnv(dir: string, env: NodeJS.ProcessEnv): Record<string, string> {
  let names: unknown
  try {
    names = (JSON.parse(readFileSync(join(dir, 'tau.json'), 'utf8')) as { env?: unknown }).env
  } catch {
    return {}
  }
  if (!Array.isArray(names)) return {}
  const values: Record<string, string> = {}
  for (const name of names) {
    if (typeof name !== 'string' || !Object.hasOwn(env, name)) continue
    const value = env[name]
    if (value !== undefined) values[name] = value
  }
  return values
}
