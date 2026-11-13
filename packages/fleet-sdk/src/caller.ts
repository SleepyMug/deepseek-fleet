/**
 * Who calls a service, as the gateway says, in the `fleet-caller-bin`
 * header of each call it carries over the service's tunnel: a box, with
 * its labels, or a client. A server serves its calls over that tunnel
 * alone, so the header is the gateway's, never the caller's own.
 * @module @sleepymug/fleet-sdk/caller
 */

import { Code, ConnectError, type HandlerContext } from '@connectrpc/connect'
import type { Caller } from '@sleepymug/fleet-protocol/fleet'
import { decodeCaller, HEADERS } from '@sleepymug/fleet-protocol/wire'

/** Who makes the call `ctx` is of. */
export function callerOf(ctx: HandlerContext): Caller {
  const header = ctx.requestHeader.get(HEADERS.caller)
  if (header === null) throw new ConnectError('fleet: the call says no caller: a service is called through the gateway alone', Code.PermissionDenied)
  return decodeCaller(header)
}

/** The box a call comes from; a call from elsewhere fails. */
export function boxOf(ctx: HandlerContext): { id: string; labels: Readonly<Record<string, string>> } {
  const { caller } = callerOf(ctx)
  if (caller.case !== 'box') throw new ConnectError('fleet: this service takes calls from boxes alone', Code.PermissionDenied)
  return { id: caller.value.id, labels: caller.value.labels }
}
