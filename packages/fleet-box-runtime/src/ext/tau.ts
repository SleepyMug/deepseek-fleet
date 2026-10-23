/**
 * The client of tau's runs (tau's docs/spec/client.md), for an extension's
 * client in the box, which finds only fleet-box-runtime and Node's modules:
 * tau's client SDK, and its fleet adaptor, whose requests reach the tau
 * service on the host through the extension that implements a contract,
 * which says, there, whose session they are. The `tau` API's client
 * (fleet-ext-tau) runs taus with it.
 * @module @sleepymug/fleet-box-runtime/ext/tau
 */

import { createClient, type Outcome, type TauClient, type Trace, traceLines } from '@sleepymug/tau'
import { createFleetAdaptor, type FleetTransport } from '@sleepymug/tau/adaptors'
import { callStream } from './client.ts'

export { createClient, createFleetAdaptor, type FleetTransport, type Outcome, type TauClient, type Trace, traceLines }

/**
 * A transport of tau's fleet adaptor through the server of the extension
 * that implements `contract`, whose method `method` takes each request as
 * its one argument, with the bytes after it, and answers with what the tau
 * service does, and the bytes after that.
 */
export function relayTransport(contract: string, method: string): FleetTransport {
  return {
    async exchange(request, body, signal) {
      // What follows the answer is empty for a request whose answer has nothing after it.
      return await callStream(contract, method, [request], { ...body === undefined ? {} : { body }, ...signal === undefined ? {} : { signal } })
    },
  }
}
