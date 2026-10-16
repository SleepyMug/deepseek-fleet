/**
 * fleet-tau-lanes, the cap on how many of the taus' model calls stream at
 * once (./lanes.ts), as a dsh plugin: every model call of a tau's session,
 * its turns', its compaction's and its title's, whatever its provider,
 * takes a lane of one pool before it reaches its provider, through dsh's
 * `llm/stream`, and gives it back as its stream ends; every other session's
 * calls go as they are. A call holds its lane only while it streams, not
 * while its tools run, so a tau that waits for the runs it started holds
 * none. A call whose wait is given up goes on without a lane, its signal
 * aborted, so its provider ends it as dsh ends an aborted call. Its config
 * is the number of lanes alone, unset for no cap, volatile, so a change
 * reaches the next call to take or give back a lane, and nothing is
 * mounted again.
 * @module @sleepymug/fleet-core/tau/lanes-plugin
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type {} from '../services.ts'
import { Lanes } from './lanes.ts'

export const name = 'fleet-tau-lanes'
export const inject = ['fleetTauRuns']

export interface Config {
  /** How many of the taus' model calls stream at once, at most; unset for as many as there are. */
  lanes: Volatile<number | undefined>
}

export const Config = z.object({
  lanes: z.natural().min(1).volatile(),
})

export function apply(ctx: Context, config: Config): void {
  const lanes = new Lanes(() => config.lanes.get())
  const runs = ctx.fleetTauRuns
  // Global, as dsh's session-title listens, so that every caller's call reaches it; after dsh's listeners, nearest the provider.
  ctx.on('llm/stream', (options, next) => {
    const { sessionId } = options
    return sessionId !== undefined && runs.isTau(sessionId) ? inLane(lanes, options, next) : next()
  }, { global: true })
}

/** A call's stream, once it has a lane, which it gives back as the stream ends, however it ends. */
async function* inLane(lanes: Lanes, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  const release = await lanes.take(options.signal)
  try {
    yield* next()
  } finally {
    release?.()
  }
}
