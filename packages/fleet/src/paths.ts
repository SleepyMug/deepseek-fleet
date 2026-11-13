/**
 * Where the gateway keeps its things, in its home: its socket, the
 * records of its boxes, and the services' packages, as it staged them.
 * @module @sleepymug/fleet/paths
 */

import { isAbsolute, join } from 'node:path'

export interface FleetPaths {
  home: string
  /** The socket its clients connect to. */
  socket: string
  /** The records of the boxes (./registry.ts). */
  boxes: string
  /** The services' packages, staged, each `<name>@<digest>`. */
  services: string
  /** The boxes' channels, each in a folder by the box's id (./channel.ts). */
  channels: string
}

/**
 * The places in a fleet home.
 * @param socket - the socket, if not the home's own.
 */
export function fleetPaths(home: string, socket?: string): FleetPaths {
  if (!isAbsolute(home)) throw new Error(`fleet: the home is an absolute path, not ${JSON.stringify(home)}`)
  return { home, socket: socket ?? join(home, 'fleet.sock'), boxes: join(home, 'boxes'), services: join(home, 'services'), channels: join(home, 'channels') }
}
