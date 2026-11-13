/**
 * The tau backend (./service.ts) as tau's rpc adaptor reaches it, a
 * `RunBackend` of tau's `tau.v1.Runs` (tau's docs/spec/rpc.md), for a
 * caller, whom each way in names, never the request: the tau service, whose
 * calls fleet's gateway carries from a box, for that box's run's session,
 * or from a client of the gateway, such as the host's `tau` command, for
 * the host (./tau-service.ts); and `tau_run` (../tools/tau.ts), for another
 * session, in this process. Its failures are Connect's: a run the caller
 * does not reach is not found, a result asked of a run that has none yet a
 * failed precondition, and a call that does not fit its tau, or breaks the
 * spec, an invalid argument.
 * @module @sleepymug/dsh-tau/tau/backend
 */

import { Code, ConnectError } from '@connectrpc/connect'
import type { RunBackend } from '@sleepymug/tau/rpc'
import type { Caller } from './registry.ts'
import type { TauService } from './service.ts'

/** What the backend asks of the service. */
export type Operations = Pick<TauService, 'submit' | 'status' | 'result' | 'trace' | 'release'>

/** The service's runs, as `caller` reaches them. */
export function backendFor(service: Operations, caller: Caller): RunBackend {
  return {
    submit: async (call, about) => (await service.submit(caller, about, call)).sessionId,
    status: id => service.status(caller, id),
    result: id => service.result(caller, id),
    trace: (id, signal) => service.trace(caller, id, signal),
    release: id => service.release(caller, id),
  }
}

/** A run the caller does not reach, as if it were not there. */
export function noRun(sessionId: string): ConnectError {
  return new ConnectError(`dsh-tau: no tau session ${sessionId}`, Code.NotFound)
}
