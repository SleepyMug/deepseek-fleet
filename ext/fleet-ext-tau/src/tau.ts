/**
 * The server of the `tau` API: the runs a tau's session starts from its box,
 * on the tau service, as that session's, so it reaches only the runs it
 * started. A run comes as a call, tau's archive, after `start`'s arguments,
 * and goes back as a result, after `finish`'s, with where the caller has its
 * handles in its box, which its client puts the result at, and its
 * session's history, if asked for. Its methods take
 * what the box sends, so they check it.
 * @module fleet-ext-tau/tau
 */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ExtMethod } from 'fleet-core/ext/plugin'
import type {} from 'fleet-core/tau/plugin'

/** What the server asks of the tau service. */
export type Service = Pick<Context['fleetTau'], 'start' | 'finish' | 'cancel'>

/** Marks an answer with bytes after it, as fleet-core's `streamed` makes one. */
const STREAMED = Symbol.for('fleet.streamed')

/** The methods, on `service`. */
export function methods(service: Service): Record<string, ExtMethod> {
  return {
    /** `start({ title, targets })`, then the call: start a run of it, and answer `{ sessionId, box, prompt }`. */
    start: async ([about], { sessionId, body }) => {
      if (body === undefined) throw new TypeError('start takes the run\'s call, after its arguments')
      return await service.start({ kind: 'session', sessionId }, checkAbout(about), body)
    },
    /**
     * `finish(id, { history? })`: wait for the run, and answer `{ result, targets }`,
     * with its session's history, `history`, if asked for, then its result.
     */
    finish: async ([id, options], { sessionId, signal }) => {
      const { archive, ...finished } = await service.finish({ kind: 'session', sessionId }, checkId(id), signal, checkFinishing(options))
      return { [STREAMED]: true, value: finished, body: archive }
    },
    /** `cancel(id)`: cancel the run's turn, which ends the run. */
    cancel: async ([id], { sessionId }) => {
      await service.cancel({ kind: 'session', sessionId }, checkId(id))
      return null
    },
  }
}

function checkAbout(about: unknown): { title: string; targets: Record<string, string> } {
  if (typeof about !== 'object' || about === null) throw new TypeError('start takes { title, targets }')
  const { title, targets } = about as Record<string, unknown>
  if (typeof title !== 'string' || title.trim() === '') throw new TypeError('start takes a title, a string')
  if (typeof targets !== 'object' || targets === null || Array.isArray(targets)
    || !Object.values(targets).every(path => typeof path === 'string' && posix.isAbsolute(path))) {
    throw new TypeError('start takes targets, each an absolute path in the box')
  }
  return { title, targets: targets as Record<string, string> }
}

function checkFinishing(options: unknown): { history?: boolean } {
  if (options === undefined) return {}
  const history = (options as { history?: unknown } | null)?.history
  if (typeof options !== 'object' || options === null || (history !== undefined && typeof history !== 'boolean')) {
    throw new TypeError('finish takes { history? }, true or false')
  }
  return history === undefined ? {} : { history }
}

function checkId(id: unknown): string {
  if (typeof id !== 'string') throw new TypeError('a run\'s id is a string')
  return id
}
