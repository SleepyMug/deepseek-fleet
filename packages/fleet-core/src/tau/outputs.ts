/**
 * What a run of a tau gives back (tau's docs/spec/results.md): what its agent
 * left at the place of each `$out` and `$inout` handle in its box. When the
 * run ends, each is copied out whole to a staging folder on the host, one
 * entry per handle, and checked there with tau's `checkOutputs`; once a
 * `finish` gives back that the run succeeded, each is put at the caller's
 * path: a folder merges into a folder already there, each of its entries put
 * the same way, and anything else replaces what is there. Paths that lie in
 * one another are put outer first, so the inner one wins. The caller's
 * paths are the host's, or in a calling session's box (./callers.ts), each
 * a {@link Target}.
 * @module fleet-core/tau/outputs
 */

import { cp, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { checkOutputs, type BoundHandle } from '@sleepymug/tau'
import { MissingInBox, type Box } from '../box/box.ts'

/**
 * Copy what the agent left at each handle's place out of its box, into
 * `staging`, which is emptied first. A place the agent left nothing at has
 * nothing staged, which the check then finds.
 */
export async function collect(box: Pick<Box, 'copyOutWhole'>, handles: readonly BoundHandle[], staging: string): Promise<void> {
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true, mode: 0o700 })
  for (const [index, handle] of handles.entries()) {
    if (handle.mode === 'in') continue
    try {
      await box.copyOutWhole(handle.view, staged(staging, index))
    } catch (error) {
      if (!(error instanceof MissingInBox)) throw error
    }
  }
}

/**
 * Check what was staged against the tau, as tau's docs/spec/paths.md asks
 * of what a run leaves.
 * @returns why it does not fit, naming each place in the box, or undefined if it does.
 */
export function check(handles: readonly BoundHandle[], staging: string): string | undefined {
  try {
    checkOutputs({ prompt: '', values: {}, handles }, handle => staged(staging, handles.indexOf(handle)))
    return undefined
  } catch (error) {
    let problems = error instanceof Error ? error.message : String(error)
    // Each place as the agent knows it, its place in the box; the highest index first, so 10 is not taken for 1.
    for (const [index, handle] of [...handles.entries()].reverse()) problems = problems.replaceAll(staged(staging, index), handle.view)
    return problems
  }
}

/** Where a run's caller has its paths, as putting what the run gave back there uses them. */
export interface Target {
  /** Where a path leads, its symlinks followed; the path itself when nothing is there. */
  resolve(path: string): Promise<string>
  /** Whether a path is a folder, and not a symlink to one. */
  isFolder(path: string): Promise<boolean>
  /** Put a staged file or folder, whole, at a path, in place of whatever is there. */
  replace(from: string, to: string): Promise<void>
}

/** The host's own files, for `fleet` on the host. */
export const hostTarget: Target = {
  resolve: path => realpath(path).catch(() => path),
  isFolder: async path => (await lstat(path).catch(() => undefined))?.isDirectory() === true,
  async replace(from, to) {
    await rm(to, { recursive: true, force: true })
    await cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
  },
}

/** Put what was staged at the caller's paths, outer ones first. */
export async function publish(handles: readonly BoundHandle[], staging: string, target: Target = hostTarget): Promise<void> {
  const given = [...handles.entries()].filter(([, handle]) => handle.mode !== 'in')
  given.sort(([, a], [, b]) => depth(a.host) - depth(b.host))
  for (const [index, handle] of given) {
    // The caller's own path leads where its symlinks do, as any path the caller names.
    await put(staged(staging, index), await target.resolve(handle.host), target)
  }
}

/** Where the handle at `index` is staged. */
function staged(staging: string, index: number): string {
  return join(staging, String(index))
}

/** A folder merges into a folder; anything else replaces what is there, as a copy that keeps modes and symlinks. */
async function put(from: string, to: string, target: Target): Promise<void> {
  if ((await lstat(from)).isDirectory() && await target.isFolder(to)) {
    for (const name of await readdir(from)) await put(join(from, name), posix.join(to, name), target)
    return
  }
  await target.replace(from, to)
}

function depth(path: string): number {
  return path.split(posix.sep).length
}
