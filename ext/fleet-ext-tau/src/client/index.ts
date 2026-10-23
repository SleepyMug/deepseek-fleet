/**
 * The client of @sleepymug/tau-api, the tau API: this run's files and args,
 * which the box's runtime kept, and runs of other taus, each in a box of its
 * own, with tau's client and its fleet adaptor, whose requests its server
 * passes to the tau service on the fleet host as this session's.
 * @module @sleepymug/fleet-ext-tau/client
 */

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createClient, createFleetAdaptor, relayTransport, traceLines, type FleetTransport } from '@sleepymug/fleet-box-runtime/ext/tau'
import { RUN } from '@sleepymug/fleet-box-runtime/tau/layout'
import type { Call, Json, Result } from '@sleepymug/tau-api'
import { CONTRACT } from './contract.ts'

/** How to run a tau, besides what tau's spec has: fleet's own. */
export interface RunOptions {
  /**
   * Where to write the run's trace, to see what its agent did, as `tau trace` prints it: a line of
   * JSON naming its format, then each event of its session, as fleet's host logs them, a line
   * each, once the run ended, whether it succeeded or not. A relative path is `process.cwd()`'s.
   */
  readonly trace?: string
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

/** The tau service on the fleet host, through this API's server, which says there whose session the requests are. */
const service: FleetTransport = relayTransport(CONTRACT, 'exchange')

/**
 * Run the tau at `tau`, a directory, with `call`. `tau` and the paths of the call's files may be
 * relative to `process.cwd()`. Resolves once the run ends, its outputs put at the call's paths,
 * and the run released; aborting `signal` releases it, and the run fails. `options` are fleet's,
 * beyond tau's spec.
 * @throws when the run cannot start, such as when `tau` is not a tau, or the call does not fit it.
 */
export async function run(tau: string, call: Call, signal?: AbortSignal, options: RunOptions = {}): Promise<Result> {
  // Its project is this session's own, which the service gives it.
  const client = createClient({ adaptors: { fleet: createFleetAdaptor({ transport: service }) } })
  const { trace } = options
  return await client.run(tau, call, {
    cwd: process.cwd(),
    ...signal === undefined ? {} : { signal },
    ...trace === undefined
      ? {}
      : {
          trace: async (given) => {
            await mkdir(dirname(resolve(trace)), { recursive: true })
            await writeFile(trace, traceLines(given))
          },
        },
  })
}

/** Init's exit code when it did the run: the agent does not run, and init's stdout is its text. */
export const TAU_SKIP = 0

/** Init's exit code when the agent is to run on the prompt, as it would without init. */
export const TAU_RUN = 100

/** Init's exit code when it failed: the agent runs, told so, as with any other ending. */
export const TAU_FALLBACK = 101
