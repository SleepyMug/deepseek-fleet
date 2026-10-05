/**
 * A run through the tau service, as a caller on the host makes it: its call
 * packed here, from the caller's files, and its result put at the caller's
 * paths here, where the targets the service gives back with it say (tau's
 * docs/spec/library.md). The service never reads or writes them.
 * @module fleet-client/runs
 */

import { applyResult, packCall } from '@sleepymug/tau/call'
import type { Result, Started } from 'fleet-protocol/tau'
import { ask, receive } from './connection.ts'

/**
 * Start a run of the tau at `tauDir` with `values`: pack its call, which
 * checks the values and the caller's paths against the tau, and send it.
 * @param cwd - what relative paths in `values` are relative to.
 * @param project - the folder whose dsh workspace the run's session is in; `cwd` by default.
 */
export async function startRun(socket: string, tauDir: string, values: unknown, cwd: string, project = cwd): Promise<Started> {
  const call = packCall(tauDir, values, { cwd })
  return await ask(socket, { op: 'start', tauDir: call.tauDir, project, targets: call.targets }, call.archive)
}

/**
 * Wait until a run ends, put what it gave back at the caller's paths, and
 * give back how it ended. Asked again, it puts the same again.
 */
export async function finishRun(socket: string, sessionId: string): Promise<Result> {
  const { value, body } = await receive(socket, { op: 'finish', sessionId })
  return await applyResult(body, value.targets)
}
