/**
 * The values of this run, and runs of other taus.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { call, callStream } from 'fleet-image/ext/client'
import { runTau, type Runtime } from 'fleet-image/ext/tau'
import { RUN } from 'fleet-image/tau/layout'

/** A value a run takes (docs/spec/values.md). */
export type Value = string | Handle | readonly Value[] | { readonly [name: string]: Value }

/** A file or a directory, with what the agent does with it. */
export type Handle = { readonly $in: string } | { readonly $out: string } | { readonly $inout: string }

/** How a run ended. */
export interface Result {
  /** Whether it succeeded. */
  readonly ok: boolean
  /** The agent's final text; empty when it gave none. */
  readonly text: string
  /** Why it failed, when it did. */
  readonly failure?: string
}

let kept: { readonly [name: string]: Value } | undefined

/** This run's values, by parameter, each handle's path where this agent sees it. */
export function values(): { readonly [name: string]: Value } {
  // As the box's runtime kept them when it set the box up.
  kept ??= (JSON.parse(readFileSync(RUN, 'utf8')) as { values: { [name: string]: Value } }).values
  return kept
}

/**
 * The fleet host, as tau's library runs a tau on a runtime: each run in a
 * box of its own, as this session's, its result put back at this box's
 * paths, where the targets say.
 */
const host: Runtime = {
  async start(packed) {
    const { value } = await callStream('tau', 'start', [{ title: basename(packed.tauDir), targets: packed.targets }], { body: packed.archive })
    return (value as { sessionId: string }).sessionId
  },
  async finish(id, signal) {
    const { value, body } = await callStream('tau', 'finish', [id], signal === undefined ? {} : { signal })
    return { result: body, targets: (value as { targets: { [pointer: string]: string } }).targets }
  },
  async cancel(id) {
    await call('tau', 'cancel', [id])
  },
}

/**
 * Run the tau at `agent`, a directory, with `values`, by parameter. `agent` and the paths of the
 * handles may be relative to `process.cwd()`. Resolves once the run ends; aborting `signal` stops
 * it, and the run fails.
 * @throws when the run cannot start, such as when `agent` is not a tau, or the values do not fit it.
 */
export function run(agent: string, values: { readonly [name: string]: Value }, signal?: AbortSignal): Promise<Result> {
  return runTau(host, agent, values, { cwd: process.cwd() }, signal)
}
