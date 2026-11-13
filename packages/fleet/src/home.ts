/**
 * Where the gateway keeps its things, in its home.
 * @module @sleepymug/fleet/home
 */

import { isAbsolute, join } from 'node:path'
import { GATEWAY_SOCKET } from '@sleepymug/fleet-protocol/layout'

export interface FleetPaths {
  home: string
  /** The socket its clients reach it on. */
  socket: string
  /** The folder of the socket its boxes reach it on, which each box mounts. */
  gatewayDir: string
  /** That socket. */
  gatewaySocket: string
  /** The records of its boxes (./boxes/registry.ts). */
  boxes: string
  /** Trees by their digest: services' packages and clients, and what the clients import (./store.ts). */
  store: string
  /** The services' specs, as staged (./services/specs.ts). */
  specs: string
}

/**
 * The places in a fleet home.
 * @param socket - its clients' socket, if not the home's own.
 */
export function fleetPaths(home: string, socket?: string): FleetPaths {
  if (!isAbsolute(home)) throw new Error(`fleet: the home is an absolute path, not ${JSON.stringify(home)}`)
  const gatewayDir = join(home, 'gateway')
  return {
    home,
    socket: socket ?? join(home, 'fleet.sock'),
    gatewayDir,
    gatewaySocket: join(gatewayDir, GATEWAY_SOCKET),
    boxes: join(home, 'boxes'),
    store: join(home, 'store'),
    specs: join(home, 'specs'),
  }
}
