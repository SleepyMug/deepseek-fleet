/**
 * Runs other agents in the tau format, each as a run of its own: the fleet
 * host starts it as a subagent of this session, in this session's project,
 * in a container of its own, where it works in a folder of that container's
 * own, with nothing of this container mounted. Its `in` paths are copied
 * from this container to their places in that folder when it starts, and
 * what it leaves at its `out` paths' places is copied back into this
 * container once it completes.
 *
 * @packageDocumentation
 */

import { resolve } from 'node:path'
import { call } from '../client.ts'

/** How a run ended. */
export interface Result {
  /**
   * Whether the run succeeded: its agent finished, and left each `out` path
   * as its tau declares, which is now in place in this container.
   */
  ok: boolean
  /** The agent's final message; empty when it wrote none. */
  message: string
  /** Why the run failed, when it did. */
  failure?: string
}

/**
 * Run the tau at `agent`, a folder in this container, with `args` as its
 * arguments, as `tau run` does. `agent` and the path arguments may be
 * relative to `process.cwd()`, and the run sees the variables its tau.json
 * lists, as `process.env` has them. The call waits until the run ends, however
 * long that takes; aborting `signal` cancels the run.
 * @throws when the run cannot start, such as when `agent` is not a tau, the arguments do not fit it, or an `in` path is missing.
 */
export async function run(agent: string, args: readonly string[], signal?: AbortSignal): Promise<Result> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  return await call('tau', 'run', [resolve(agent), [...args], process.cwd(), env], signal) as Result
}
