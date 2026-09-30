/**
 * The host's side of one container's service calls: the calls its helper
 * relays from programs in the container (fleet-box-helper's services.ts),
 * served by a handler within fixed bounds, and each answered once unless the
 * program went away. The helper is in the model's reach, so nothing it sends is
 * trusted: names are checked, sizes bounded both ways, the calls in flight
 * capped, and an id already in flight gets no second answer.
 * @module fleet-box/calls
 */

import { MAX_CALL_BYTES, type HostMessage } from 'fleet-box-helper/protocol'

/** Calls one container may have in flight; more are refused at once. */
const MAX_CALLS = 16
/** Characters of a failed call's message sent back to the container. */
const MAX_CALL_ERROR = 16 * 1024
/** Service and function names: identifiers or file-name-like names, no longer than this. */
const CALL_NAME = /^[A-Za-z0-9_$][A-Za-z0-9._$-]{0,127}$/u
const MIB = 1024 * 1024

/** A service call a program in the container made, as the helper relays it. */
export interface ServiceCallRequest {
  service: string
  function: string
  args: unknown[]
}

/**
 * Serves the service calls of one container.
 * @param signal - aborts when the program goes away or the connection ends.
 * @returns the call's result, JSON; a throw's message goes back to the program.
 */
export type CallHandler = (call: ServiceCallRequest, signal: AbortSignal) => Promise<unknown>

export class ServiceCalls {
  private readonly inFlight = new Map<number, AbortController>()
  private handler: CallHandler | undefined

  /** @param send - writes one line to the helper. */
  constructor(private readonly send: (line: string) => void) {}

  /** Serve the calls from now on; until then, every call fails. */
  serve(handler: CallHandler): void {
    this.handler = handler
  }

  /**
   * Serve one call the helper relayed.
   * @param bytes - the size of the message that carried it.
   */
  receive(request: ServiceCallRequest & { call: number }, bytes: number): void {
    if (this.inFlight.has(request.call)) return
    const refuse = (reason: string): void => { this.answer({ type: 'call-error', call: request.call, message: reason.slice(0, MAX_CALL_ERROR) }) }
    if (bytes > MAX_CALL_BYTES) return refuse(`the call is over the ${MAX_CALL_BYTES / MIB} MiB limit`)
    if (!CALL_NAME.test(request.service) || !CALL_NAME.test(request.function)) return refuse('the call names no valid service and function')
    if (this.inFlight.size >= MAX_CALLS) return refuse(`too many service calls at once; at most ${MAX_CALLS} run together`)
    const handler = this.handler
    if (handler === undefined) return refuse('no services are provided here')
    const controller = new AbortController()
    this.inFlight.set(request.call, controller)
    void Promise.resolve()
      .then(() => handler({ service: request.service, function: request.function, args: request.args }, controller.signal))
      .then(
        (result) => {
          if (controller.signal.aborted) return
          const line = JSON.stringify({ type: 'call-result', call: request.call, result: result ?? null } satisfies HostMessage)
          if (Buffer.byteLength(line) > MAX_CALL_BYTES) refuse(`the result is over the ${MAX_CALL_BYTES / MIB} MiB limit`)
          else this.send(line)
        },
        (error: unknown) => { if (!controller.signal.aborted) refuse(error instanceof Error ? error.message : String(error)) },
      )
      .finally(() => { this.inFlight.delete(request.call) })
  }

  /** Stop a call whose program went away; it gets no answer. */
  cancel(call: number): void {
    this.inFlight.get(call)?.abort(new Error('the program went away'))
  }

  /** Stop every call, as when the connection ends. */
  abortAll(reason: Error): void {
    for (const controller of this.inFlight.values()) controller.abort(reason)
    this.inFlight.clear()
  }

  private answer(message: Extract<HostMessage, { type: 'call-error' }>): void {
    this.send(JSON.stringify(message))
  }
}
