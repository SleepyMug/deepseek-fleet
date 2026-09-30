/**
 * What each service binding in a session container calls (./binding.ts):
 * the calls of programs and modules to a service, checked against the
 * agent's manifest and converted for the wire with tau's codec, bytes as
 * base64, go from the calling process to fleet-box's service socket at
 * $TAU_SOCKET, one connection each (./tau-client.ts), and their results
 * come back converted, bytes as a `Uint8Array`. The call is cancelled when
 * the process ends, which closes its connection. `fleet-setup image` puts
 * this file at ./protocol.ts's `SERVICE_CLIENT`, where the bindings import
 * it from.
 * @module fleet-tau-runner/service
 */

import type { JsonValue, ServiceSchema, Value } from '@sleepymug/tau'
import { serviceCodec } from '@sleepymug/tau/codec'
import { callService } from './tau-client.ts'

/** Calls to one service, whose schema is the agent's manifest's canonical one. */
export function bindService(schema: ServiceSchema): (fn: string, args: readonly unknown[]) => Promise<Value> {
  const codec = serviceCodec(schema)
  const never = new AbortController().signal
  return async (fn, args) => {
    const socket = process.env.TAU_SOCKET
    if (socket === undefined || socket === '') throw new Error(`${codec.name}.${fn}: TAU_SOCKET is not set, so no service can be reached`)
    // An optional argument left out, as TypeScript lets a program pass undefined for it.
    let given = args.length
    while (given > 0 && args[given - 1] === undefined) given--
    const wire = codec.encodeArguments(fn, args.slice(0, given) as Value[])
    return codec.decodeResult(fn, await callService(socket, codec.name, fn, wire, never) as JsonValue)
  }
}
