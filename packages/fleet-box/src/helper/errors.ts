/**
 * The helper's failures, as a box's API reports them: a system call's
 * failure by its errno, a bad request as an invalid argument, each with
 * what it was about.
 * @module @sleepymug/fleet-box/helper/errors
 */

import { Code, ConnectError } from '@connectrpc/connect'

const CODES: Readonly<Record<string, Code>> = {
  ENOENT: Code.NotFound,
  EEXIST: Code.AlreadyExists,
  EACCES: Code.PermissionDenied,
  EPERM: Code.PermissionDenied,
  ENOTDIR: Code.FailedPrecondition,
  EISDIR: Code.FailedPrecondition,
  ENOTEMPTY: Code.FailedPrecondition,
  EXDEV: Code.FailedPrecondition,
  ELOOP: Code.FailedPrecondition,
  ENOSPC: Code.ResourceExhausted,
  EMFILE: Code.ResourceExhausted,
}

/** A system call's failure, `what` failing, as the error its errno says. */
export function systemError(error: unknown, what: string): ConnectError {
  if (error instanceof ConnectError) return error
  const errno = (error as NodeJS.ErrnoException | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  return new ConnectError(`${what}: ${message}`, (errno === undefined ? undefined : CODES[errno]) ?? Code.Internal)
}

/** A request that cannot be done as it is. */
export function invalid(message: string): ConnectError {
  return new ConnectError(message, Code.InvalidArgument)
}
