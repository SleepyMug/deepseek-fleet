/**
 * Where a gateway is on its machine, which the gateway and its clients
 * agree on: its home, and the socket its clients reach it on.
 * @module @sleepymug/fleet-protocol/home
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

/** The gateway's home: `$FLEET_HOME`, or `~/.fleet`. */
export function fleetHome(env: Env = process.env): string {
  const given = env.FLEET_HOME ?? ''
  return given.trim() === '' ? join(homedir(), '.fleet') : resolve(given)
}

/** The socket its clients reach it on: `$FLEET_SOCKET`, or `fleet.sock` in its home. */
export function fleetSocket(env: Env = process.env): string {
  const given = env.FLEET_SOCKET ?? ''
  return given.trim() === '' ? join(fleetHome(env), 'fleet.sock') : resolve(given)
}
