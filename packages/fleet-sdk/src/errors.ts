/**
 * The gateway's failures, as its client reads them: each a `ConnectError`,
 * with its code, and the gateway's reason for it, if it gave one.
 * @module @sleepymug/fleet-sdk/errors
 */

import { ConnectError } from '@connectrpc/connect'
import { FailureSchema, Reason } from '@sleepymug/fleet-protocol/gateway'

/** No gateway answers on the socket. */
export class FleetUnreachable extends Error {
  constructor(readonly socket: string, cause?: unknown) {
    super(`no gateway answers on ${socket}; start one with \`fleet serve\``, { cause })
  }
}

/** The gateway's reason for a failure, if it gave one. */
export function reasonOf(error: unknown): Reason | undefined {
  return error instanceof ConnectError ? error.findDetails(FailureSchema)[0]?.reason : undefined
}

export { Reason }
