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
import { createClient, createFleetAdaptor, relayTransport, type FleetTransport } from '@sleepymug/fleet-box-runtime/ext/tau'
import { RUN } from '@sleepymug/fleet-box-runtime/tau/layout'
import type { Call, Json, Result } from '@sleepymug/tau-api'
import { CONTRACT } from './contract.ts'

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

/** The tau service on the fleet host, through this API's server, which says there whose session the requests are. */
const service: FleetTransport = relayTransport(CONTRACT, 'exchange')

/**
 * Run the tau at `agent`, a directory, with `call`. `agent` and the paths of the call's files may
 * be relative to `process.cwd()`. Resolves once the run ends, its outputs put at the call's paths,
 * and the run released; aborting `signal` releases it, and the run fails. `options` are fleet's,
 * beyond tau's spec.
 * @throws when the run cannot start, such as when `agent` is not a tau, or the call does not fit it.
 */
export async function run(agent: string, call: Call, signal?: AbortSignal, options: RunOptions = {}): Promise<Result> {
  // Its project is this session's own, which the service gives it.
  const client = createClient({ adaptors: { fleet: createFleetAdaptor({ transport: service }) } })
  const { history } = options
  if (history === undefined) return await client.run(agent, call, { cwd: process.cwd(), ...signal === undefined ? {} : { signal } })
  const started = await client.start(agent, call, { cwd: process.cwd(), ...signal === undefined ? {} : { signal } })
  try {
    const result = await client.finish(started, signal === undefined ? {} : { signal })
    const { value } = await service.exchange({ op: 'history', id: started.slice('fleet:'.length) }, undefined, signal)
    await mkdir(dirname(resolve(history)), { recursive: true })
    await writeFile(history, (value as unknown[]).map(event => `${JSON.stringify(event)}\n`).join(''))
    return result
  } catch (error) {
    if (signal?.aborted !== true) throw error
    return { ok: false, text: '', failure: 'the run was stopped' }
  } finally {
    await client.release(started).catch(() => {})
  }
}

/** Init's exit code when it did the run: the agent does not run, and init's stdout is its text. */
export const TAU_SKIP = 0

/** Init's exit code when the agent is to run on the prompt, as it would without init. */
export const TAU_RUN = 100

/** Init's exit code when it failed: the agent runs, told so, as with any other ending. */
export const TAU_FALLBACK = 101
