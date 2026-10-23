/**
 * The tau service's requests (./service.ts), as tau's fleet adaptor makes a
 * run's, submit, status, result, trace and release, and a contract's (tau's
 * docs/spec/fleet.md), and as fleet-protocol has the service's own, list,
 * served for a caller, whom each way in names, never the request: the
 * socket, which tau's `listenFleet` serves (./plugin.ts), for the host; the
 * `tau` API's extension (fleet-ext-tau), for a tau's session, from its box;
 * and `tau_run` (../tools/tau.ts), for another session, in this process.
 * What a caller sends is checked here.
 * @module @sleepymug/fleet-core/tau/wire
 */

import { type FleetHandler, readFleetContractRequest, readFleetRunRequest } from '@sleepymug/tau/adaptors'
import type { Caller } from './registry.ts'
import type { TauService } from './service.ts'

/** What the wire asks of the service. */
export type Operations = Pick<TauService, 'submit' | 'status' | 'result' | 'trace' | 'release' | 'contract' | 'list'>

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
    const asked = readFleetContractRequest(request)
    if (asked !== undefined) return service.contract(asked.name, asked.range)
    if (request.op === 'list') return { value: await service.list(caller) }
    throw new Error(`fleet: no op ${request.op}`)
  }
}
