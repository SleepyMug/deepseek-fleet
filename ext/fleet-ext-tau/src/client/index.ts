/**
 * This run's files and args, and runs of other taus.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { call, callStream } from 'fleet-box-runtime/ext/client'
import { runTau, type Runtime } from 'fleet-box-runtime/ext/tau'
import { RUN } from 'fleet-box-runtime/tau/layout'

/** A JSON value. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json }

/**
 * A file of a call given with its mode: one the tau does not declare, which the call gives the
 * agent beside those it declares, or one it does.
 */
export interface CallFile {
  readonly mode: 'in' | 'out' | 'inout'
  /** Its path, or, for an `in` file, a list of paths. */
  readonly path: string | readonly string[]
  /** What it is, a file or a directory; without it, either. */
  readonly kind?: 'file' | 'dir'
}

/** A call of a tau (docs/spec/calls.md): a path for each of its files, extra files, and its args. */
export interface Call {
  /** A path for each file, by name, or, for an `in` file, a list of paths, or the file with its mode. */
  readonly files?: { readonly [name: string]: string | readonly string[] | CallFile }
  /** The args, which fit the tau's schema. */
  readonly args?: { readonly [name: string]: Json }
}

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

/** What the box's runtime kept of this run when it set the box up: where the agent sees each file, and the args, expanded. */
interface Kept {
  places: { readonly [name: string]: string }
  args: { readonly [name: string]: Json }
}

let kept: Kept | undefined

function read(): Kept {
  kept ??= JSON.parse(readFileSync(RUN, 'utf8')) as Kept
  return kept
}

/** Where this agent sees each of this run's files, by name, extra files included. */
export function files(): { readonly [name: string]: string } {
  return read().places
}

/**
 * This run's args, their placeholders expanded: each `${self}`, `${name}` naming a file, and
 * `${name}` naming an arg, and each run of `$` before a `{` with one `$` less.
 */
export function args(): { readonly [name: string]: Json } {
  return read().args
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
      const finished = value as { targets: { [name: string]: string }; history?: unknown[] }
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
 * Run the tau at `agent`, a directory, with `call`. `agent` and the paths of the call's files may
 * be relative to `process.cwd()`. Resolves once the run ends; aborting `signal` stops it, and the
 * run fails. `options` are fleet's, beyond tau's spec.
 * @throws when the run cannot start, such as when `agent` is not a tau, or the call does not fit it.
 */
export function run(agent: string, call: Call, signal?: AbortSignal, options: RunOptions = {}): Promise<Result> {
  return runTau(host(options.history), agent, call, process.cwd(), signal)
}

/** Init's exit code when it did the run: the agent does not run, and init's stdout is its text. */
export const TAU_SKIP = 0

/** Init's exit code when the agent is to run on the prompt, as it would without init. */
export const TAU_RUN = 100

/** Init's exit code when it failed: the agent runs, told so, as with any other ending. */
export const TAU_FALLBACK = 101
