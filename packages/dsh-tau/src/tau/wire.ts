/**
 * The tau backend's requests (./service.ts), as tau's socket adaptor makes a
 * run's, submit, status, result, trace and release (tau's
 * docs/spec/socket.md), and as dsh-tau-box's runs has the backend's own,
 * list, served for a caller, whom each way in names, never the request: the
 * socket in the dsh home (./plugin.ts), for the host; the tau service, whose
 * connections the fleet host relays from a box (./plugin.ts), for a tau's
 * session; and `tau_run` (../tools/tau.ts), for another session, in this
 * process. What a caller sends is checked here.
 * @module @sleepymug/dsh-tau/tau/wire
 */

import { readRunRequest, type RequestHandler } from '@sleepymug/tau/adaptors'
import type { Caller } from './registry.ts'
import type { TauService } from './service.ts'

/** What the wire asks of the service. */
export type Operations = Pick<TauService, 'submit' | 'status' | 'result' | 'trace' | 'release' | 'list'>

/** The service's requests, made by `caller`. */
export function serveFor(service: Operations, caller: Caller): RequestHandler {
  return async (request, body, signal) => {
    const run = readRunRequest(request)
    if (run !== undefined) {
      switch (run.op) {
        case 'submit': {
          const { sessionId } = await service.submit(caller, { title: run.title, ...run.project === undefined ? {} : { project: run.project } }, body)
          return { value: { id: sessionId } }
        }
        case 'status':
          return { value: await service.status(caller, run.id) }
        case 'result':
          return await service.result(caller, run.id)
        case 'trace':
          return { value: await service.trace(caller, run.id, signal) }
        case 'release':
          await service.release(caller, run.id)
          return { value: null }
      }
    }
    if (request.op === 'list') return { value: await service.list(caller) }
    throw new Error(`dsh-tau: no op ${request.op}`)
  }
}
