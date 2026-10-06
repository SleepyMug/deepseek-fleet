/**
 * The values of this run, and runs of other taus.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { call, callStream } from 'fleet-box-runtime/ext/client'
import { runTau, type Runtime } from 'fleet-box-runtime/ext/tau'
import { RUN } from 'fleet-box-runtime/tau/layout'

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

/** How to run a tau, besides what tau's spec has: fleet's own. */
export interface RunOptions {
  /**
   * Where to write the run's session history, to see what its agent did: its events, one JSON
   * object per line, as fleet's host logs them, whether the run succeeded or not. A relative path
   * is `process.cwd()`'s.
   */
  readonly history?: string
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
 * paths, where the targets say, and its session's history at `history`, if
 * given, before.
 */
function host(history: string | undefined): Runtime {
  return {
    async start(packed) {
      const { value } = await callStream('tau', 'start', [{ title: basename(packed.tauDir), targets: packed.targets }], { body: packed.archive })
      return (value as { sessionId: string }).sessionId
    },
    async finish(id, signal) {
      const args = history === undefined ? [id] : [id, { history: true }]
      const { value, body } = await callStream('tau', 'finish', args, signal === undefined ? {} : { signal })
      const finished = value as { targets: { [pointer: string]: string }; history?: unknown[] }
      if (history !== undefined) {
        await mkdir(dirname(resolve(history)), { recursive: true })
        await writeFile(history, (finished.history ?? []).map(event => `${JSON.stringify(event)}\n`).join(''))
      }
      return { result: body, targets: finished.targets }
    },
    async cancel(id) {
      await call('tau', 'cancel', [id])
    },
  }
}

/**
 * Run the tau at `agent`, a directory, with `values`, by parameter. `agent` and the paths of the
 * handles may be relative to `process.cwd()`. Resolves once the run ends; aborting `signal` stops
 * it, and the run fails. `options` are fleet's, beyond tau's spec.
 * @throws when the run cannot start, such as when `agent` is not a tau, or the values do not fit it.
 */
export function run(agent: string, values: { readonly [name: string]: Value }, signal?: AbortSignal, options: RunOptions = {}): Promise<Result> {
  return runTau(host(options.history), agent, values, { cwd: process.cwd() }, signal)
}

/** Init's exit code when it did the run: the agent does not run, and init's stdout is its text. */
export const TAU_SKIP = 0

/** Init's exit code when the agent is to run on the prompt, as it would without init. */
export const TAU_RUN = 100

/** Init's exit code when it failed: the agent runs, told so, as with any other ending. */
export const TAU_FALLBACK = 101
