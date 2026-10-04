/**
 * The wire between `fleet` (fleet-client) and the tau service in the fleet
 * host (fleet-core/tau): a Unix socket in the dsh home, on which a client
 * sends one request as one line of JSON, and the service answers it with one
 * line of JSON and ends the connection. Shared by both ends, so it holds only
 * types, constants, and where the socket is.
 * @module fleet-protocol/tau
 */

import { join } from 'node:path'

/** Wire version; the service refuses a request with another. */
export const PROTOCOL_VERSION = 1

/** Where the service listens in a dsh home. */
export function socketPath(dshHome: string): string {
  return join(dshHome, 'fleet', 'tau.sock')
}

/**
 * A run's values, by parameter, as tau's docs/spec/values.md has them. The
 * service checks them against the tau.
 */
export type Values = { readonly [name: string]: unknown }

/** Client to service. Paths are absolute. */
export type Request =
  | {
    protocol: number
    /** Set up a box for a run of the tau at `tauDir` with `values`, whose relative paths are `callerCwd`'s. */
    op: 'create'
    tauDir: string
    callerCwd: string
    values: Values
  }
  | {
    protocol: number
    /** Start, stop, or remove the session's box; `delete` forgets the session too. */
    op: 'start' | 'stop' | 'delete'
    sessionId: string
  }

/** What `create` answers with. */
export interface Created {
  /** The session the run will be, minted by the service. */
  sessionId: string
  /** The box's container. */
  box: string
  /** The tau's prompt, expanded with where the box has each handle. */
  prompt: string
}

/** Service to client: `value` is `create`'s {@link Created}, and null for the other ops. */
export type Response =
  | { ok: true; value: Created | null }
  | { ok: false; error: string }
