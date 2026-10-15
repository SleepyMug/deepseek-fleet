/**
 * fleet-client, fleet-core's row for its browser half (./client/index.ts):
 * dsh's web client loads a package's `./client` bundle only for a row that
 * names the package itself, not one of its modules, so this row does, and
 * does nothing on the host.
 * @module @sleepymug/fleet-core
 */

export const name = 'fleet-client'

export function apply(): void {}
