/**
 * The tau service's requests (./service.ts), as tau's fleet adaptor makes a
 * run's, submit, finish and release (tau's docs/spec/fleet.md), and as
 * fleet-protocol has the service's own, list, status and history, served
 * for a caller, whom each way in names, never the request: the socket
 * (./server.ts), for the host; the `tau` API's extension (fleet-ext-tau),
 * for a tau's session, from its box; and `tau_run` (../tools/tau.ts), for
 * another session, in this process. What a caller sends is checked here.
 * @module @sleepymug/fleet-core/tau/wire
 */

import { type FleetHandler, readFleetRunRequest } from '@sleepymug/tau/adaptors'
import type { Caller } from './registry.ts'
import type { TauService } from './service.ts'

/** What the wire asks of the service. */
export type Operations = Pick<TauService, 'submit' | 'finish' | 'release' | 'list' | 'status' | 'history'>

/** The service's requests, made by `caller`. */
export function serveFor(service: Operations, caller: Caller): FleetHandler {
  return async (request, body, signal) => {
    const run = readFleetRunRequest(request)
    if (run !== undefined) {
      switch (run.op) {
        case 'submit': {
          const { sessionId } = await service.submit(caller, { title: run.title, ...run.project === undefined ? {} : { project: run.project } }, body)
          return { value: { id: sessionId } }
        }
        case 'finish':
          return { value: null, body: await service.finish(caller, run.id, signal) }
        case 'release':
          await service.release(caller, run.id)
          return { value: null }
      }
    }
    switch (request.op) {
      case 'list':
        return { value: await service.list(caller) }
      case 'status':
        return { value: await service.status(caller, idOf(request)) }
      case 'history':
        return { value: await service.history(caller, idOf(request), signal) }
      default:
        throw new Error(`fleet: no op ${request.op}`)
    }
  }
}

function idOf(request: { op: string; id?: unknown }): string {
  if (typeof request.id !== 'string' || request.id === '') throw new TypeError(`fleet: ${request.op} takes the run's id, a string`)
  return request.id
}
