/**
 * What answers the calls of the clients in a run's box: the server of the
 * extension that implements the contract, for a contract of an API the
 * run's tau names, with the session the box is, whatever the call says.
 * @module @sleepymug/fleet-core/tau/calls
 */

import type { CallHandler } from '../box/helper.ts'
import type { Exts } from './apis.ts'

/**
 * @param apis - the contracts of the APIs the session's tau names now, asked for each call.
 */
export function callsOf(exts: Exts, sessionId: string, apis: () => Promise<readonly string[]>): CallHandler {
  return async ({ contract, method, args }, signal, body) => {
    if (!(await apis()).includes(contract)) throw new Error(`fleet: this run's tau names no API ${contract}`)
    const ext = exts.get(contract)
    if (ext === undefined) throw new Error(`fleet: no extension implements ${contract} now`)
    if (!Object.hasOwn(ext.methods, method)) throw new Error(`fleet: the extension of ${contract} has no method ${method}`)
    return await ext.methods[method]?.(args, { sessionId, signal, ...body === undefined ? {} : { body } })
  }
}
