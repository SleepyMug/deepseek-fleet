/**
 * The gateway's refusals: each an error with its code, and its reason,
 * fleet.gateway.v1's `Failure`, as a detail, which the caller's client reads.
 * @module @sleepymug/fleet/failure
 */

import { create } from '@bufbuild/protobuf'
import { Code, ConnectError } from '@connectrpc/connect'
import { FailureSchema, Reason } from '@sleepymug/fleet-protocol/gateway'

export function failure(reason: Reason, code: Code, message: string): ConnectError {
  return new ConnectError(message, code, undefined, [{ desc: FailureSchema, value: create(FailureSchema, { reason }) }])
}

export const noBox = (id: string): ConnectError => failure(Reason.NO_BOX, Code.NotFound, `fleet: no box ${id}`)
export const boxGone = (id: string): ConnectError => failure(Reason.BOX_GONE, Code.FailedPrecondition, `fleet: the container of ${id} is gone; make another box`)
export const notStarted = (id: string): ConnectError => failure(Reason.NOT_STARTED, Code.FailedPrecondition, `fleet: ${id} is not started`)
export const noService = (message: string): ConnectError => failure(Reason.NO_SERVICE, Code.NotFound, `fleet: ${message}`)
export const unknownSpec = (digest: string): ConnectError => failure(Reason.UNKNOWN_SPEC, Code.NotFound, `fleet: no spec ${digest} is staged; stage it`)
export const noPackage = (digest: string): ConnectError => failure(Reason.NO_PACKAGE, Code.FailedPrecondition, `fleet: the package ${digest} is not uploaded; upload it`)
export const nameTaken = (name: string): ConnectError => failure(Reason.NAME_TAKEN, Code.AlreadyExists, `fleet: another server serves ${name} now`)

/** The reason an error carries, if it carries one. */
export function reasonOf(error: unknown): Reason | undefined {
  return error instanceof ConnectError ? error.findDetails(FailureSchema)[0]?.reason : undefined
}
