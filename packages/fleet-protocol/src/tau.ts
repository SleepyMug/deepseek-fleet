/**
 * The tau service's own requests (fleet-core/tau), beside a run's, which
 * tau's fleet adaptor makes (tau's docs/spec/fleet.md), its status, result
 * and trace among them: on its socket in the dsh home, or from a box,
 * through the `tau` API's extension, a request is a JSON object with its
 * `op`, and its answer JSON. Shared by both ends, so it holds only types,
 * and where the socket is.
 * @module @sleepymug/fleet-protocol/tau
 */

import { join } from 'node:path'

/** Where the service listens in a dsh home, as tau's `defaultFleetSocket` finds it. */
export function socketPath(dshHome: string): string {
  return join(dshHome, 'fleet', 'tau.sock')
}

/** What the service is asked besides a run's own requests, tau's. */
export type Request =
  /** Every run the caller reaches, oldest first. */
  | { op: 'list' }

/** How a run ended, as tau's docs/spec/results.md has it. */
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
 * with its result, and `finished` once its result was first given back.
 */
export type RunState = 'running' | 'ended' | 'finished'

/** What `list` answers with for each run. */
export interface RunStatus {
  /** The run's id, its session's. */
  sessionId: string
  /** The run that started this one from its box, if one did. */
  parent?: string
  /** What names the run, as its caller gave it. */
  title: string
  /** The caller's folder, the dsh workspace the session is in. */
  project: string
  /** The tau's prompt, expanded with where the box has each file. */
  prompt: string
  state: RunState
  createdAt: string
  /** When the run ended, once it did. */
  endedAt?: string
  /** How it ended, once it did. */
  result?: Result
}

/** What each op answers with. */
export interface Answers {
  list: RunStatus[]
}
