/**
 * The server of @sleepymug/tau-api, the tau API: the relay of tau's fleet
 * adaptor in a tau's box (fleet-box-runtime/ext/tau), whose every request,
 * a run's or the service's own (tau's docs/spec/fleet.md), with the bytes
 * after it, it passes to the tau service as the calling session's, so it
 * reaches only the runs that session started; and the answer back, with
 * the bytes after it. The service checks each request, as one from the box.
 * @module @sleepymug/fleet-ext-tau/tau
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ExtMethod } from '@sleepymug/fleet-core/ext/plugin'
import type {} from '@sleepymug/fleet-core/tau/plugin'

/** What the server asks of the tau service. */
export type Service = Pick<Context['fleetTau'], 'handlerFor'>

/** Marks an answer with bytes after it, as fleet-core's `streamed` makes one. */
const STREAMED = Symbol.for('fleet.streamed')

/** The methods, on `service`. */
export function methods(service: Service): Record<string, ExtMethod> {
  return {
    /** `exchange(request)`, then what follows it, if anything: the service's answer, then what follows that, if anything. */
    exchange: async ([request], { sessionId, signal, body }) => {
      if (typeof request !== 'object' || request === null || Array.isArray(request) || typeof (request as { op?: unknown }).op !== 'string') {
        throw new TypeError('exchange takes a request, { op, … }')
      }
      const answer = await service.handlerFor({ kind: 'session', sessionId })(request as { op: string }, body ?? empty(), signal)
      return answer.body === undefined ? answer.value ?? null : { [STREAMED]: true, value: answer.value, body: answer.body }
    },
  }
}

async function* empty(): AsyncGenerator<Uint8Array> {}
