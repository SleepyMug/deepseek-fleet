/**
 * The wire between `fleet` (fleet-client) and the tau service in the fleet
 * host (fleet-core/tau): a Unix socket in the dsh home, on which a client
 * sends one request as one line of JSON, and the service answers it with one
 * line of JSON and ends the connection. A `start` sends a run's call after
 * its line, and a `finish` that succeeds answers with the run's result after
 * its line, each an archive of tau's docs/spec/serialization.md. Shared by
 * both ends, so it holds only types, constants, and where the socket is.
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
 * Where the caller has each `$out` and `$inout` handle of a run: its path,
 * absolute, by the handle's JSON Pointer into the values, as tau's
 * `packCall` gives them. The service keeps them, without reading them, and
 * gives them back with the run's result, which the caller puts there.
 */
export type Targets = { readonly [pointer: string]: string }

/** Client to service. Paths are absolute. */
export type Request =
  | {
    protocol: number
    /**
     * Start a run of the call that follows the line, up to the end of what
     * the client sends: tau's call archive, which carries the tau.
     */
    op: 'start'
    /** The tau's directory, as the caller has it, which `list` shows. */
    tauDir: string
    /** The caller's folder: the dsh workspace the run's session is in. */
    project: string
    targets: Targets
  }
  | {
    protocol: number
    /** Every run, oldest first. */
    op: 'list'
  }
  | {
    protocol: number
    /**
     * Where a run is; wait for its end, and give back how it ended; cancel
     * its turn; or archive its session, remove its box and forget it.
     */
    op: 'status' | 'finish' | 'cancel' | 'delete'
    sessionId: string
  }

/** What `start` answers with. */
export interface Started {
  /** The session the run is, minted by the service. */
  sessionId: string
  /** The box's container. */
  box: string
  /** The tau's prompt, expanded with where the box has each handle. */
  prompt: string
}

/** How a run ended, as tau's docs/spec/tau-api.md has it. */
export interface Result {
  /** Whether it succeeded. */
  ok: boolean
  /** The agent's final text; empty when it gave none. */
  text: string
  /** Why it failed, when it did. */
  failure?: string
}

/**
 * Where a run is: `running` until its agent is done, `ended` once it is,
 * with its result, and `finished` once a `finish` has given that back.
 */
export type RunState = 'running' | 'ended' | 'finished'

/** What `status` answers with, and `list` with for each run. */
export interface RunStatus {
  sessionId: string
  /** The run that started this one from its box, if one did. */
  parent?: string
  /** The tau's directory, as its caller has it. */
  tauDir: string
  /** The caller's folder, the dsh workspace the session is in. */
  project: string
  state: RunState
  createdAt: string
  /** When the run ended, once it did. */
  endedAt?: string
  /** How it ended, once it did. */
  result?: Result
}

/**
 * What `finish` answers with, before the result's archive, which holds what
 * the run gave back for each target.
 */
export interface Finished {
  result: Result
  targets: Targets
}

/** What each op answers with. */
export interface Answers {
  start: Started
  list: RunStatus[]
  status: RunStatus
  finish: Finished
  cancel: null
  delete: null
}

/** Service to client: `value` is what the op answers with ({@link Answers}). */
export type Response =
  | { ok: true; value: Answers[keyof Answers] }
  | { ok: false; error: string }
