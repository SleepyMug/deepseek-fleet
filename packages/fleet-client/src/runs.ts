/**
 * A run through the tau service, as a caller on the host makes it: its call
 * packed here, from the caller's files, and its result put at the caller's
 * paths here, where the targets the service gives back with it say (tau's
 * docs/spec/library.md), as is its session's history, if asked for. The
 * service never reads or writes them.
 * @module fleet-client/runs
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { applyResult, packCall } from '@sleepymug/tau/call'
import type { Result, Started } from 'fleet-protocol/tau'
import { ask, receive } from './connection.ts'

/**
 * Start a run of the tau at `tauDir` with `values`: pack its call, which
 * checks the values and the caller's paths against the tau, and send it,
 * titled with the name of the tau's directory.
 * @param cwd - what relative paths in `values` are relative to.
 * @param project - the folder whose dsh workspace the run's session is in; `cwd` by default.
 */
export async function startRun(socket: string, tauDir: string, values: unknown, cwd: string, project = cwd): Promise<Started> {
  const call = packCall(tauDir, values, { cwd })
  return await ask(socket, { op: 'start', title: basename(call.tauDir), project, targets: call.targets }, call.archive)
}

/**
 * Wait until a run ends, put what it gave back at the caller's paths, and
 * give back how it ended. Asked again, it puts the same again.
 * @param history - where to write the run's session's history, if anywhere:
 *   its events as dsh logs them, one JSON per line, whether the run succeeded or not.
 */
export async function finishRun(socket: string, sessionId: string, history?: string): Promise<Result> {
  const { value, body } = await receive(socket, { op: 'finish', sessionId, ...history === undefined ? {} : { history: true } })
  if (history !== undefined) {
    await mkdir(dirname(resolve(history)), { recursive: true })
    await writeFile(history, (value.history ?? []).map(event => `${JSON.stringify(event)}\n`).join(''))
  }
  return await applyResult(body, value.targets)
}
