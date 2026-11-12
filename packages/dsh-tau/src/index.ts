/**
 * fleet-sdk, dsh-tau's row for its browser half (./client/index.ts):
 * dsh's web client loads a package's `./client` bundle only for a row that
 * names the package itself, not one of its modules, so this row does, and
 * does nothing on the host.
 * @module @sleepymug/dsh-tau
 */

export const name = 'fleet-sdk'

export function apply(): void {}
