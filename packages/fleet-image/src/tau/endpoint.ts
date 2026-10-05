/**
 * The runtime's side of a tau's run, in its box (tau's docs/spec/library.md):
 * the host has the box place the run's call, which the host read and checked
 * first, at the places of the handles, and, once the run ended well, pack
 * the run's result from them, which the host reads and checks again, since
 * the box is the run's agent's. Each runs as ./main.ts, with `docker exec`.
 * @module fleet-image/tau/endpoint
 */

import { join } from 'node:path'
import type { BoundHandle } from '@sleepymug/tau'
import { packResult, placeCall, readCall, type Result } from '@sleepymug/tau/call'

/**
 * Give each handle of a call that has content its content, at its view.
 * @param root - where the views are, the box's root unless a test has them elsewhere.
 */
export async function place(call: AsyncIterable<Uint8Array>, handles: readonly BoundHandle[], root = '/'): Promise<void> {
  await placeCall(await readCall(call), { handles: handles.map(handle => ({ ...handle, view: join(root, handle.view) })) })
}

/**
 * The result's archive of a run that ended as `outcome` says: what the agent
 * left at each `$out` and `$inout` handle's view, checked, or, when it does
 * not fit the tau, a failure.
 * @param root - where the views are, the box's root unless a test has them elsewhere.
 */
export function pack(outcome: Result, handles: readonly BoundHandle[], root = '/'): AsyncIterable<Uint8Array> {
  return packResult(outcome, handles, ({ view }) => join(root, view))
}
