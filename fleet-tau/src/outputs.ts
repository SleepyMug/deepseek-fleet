/**
 * Publishing an agent's `copy-out` paths: what the agent left in its
 * container, copied out to the store by fleet-box, which copies plain files
 * and folders only, is checked again here, and as tau checks a run's
 * outputs, and then replaces the caller's path. The copy comes from the container, which the model controls, so it
 * is taken only as plain files and folders of bounded size: a symlink, a
 * hard link, a device, a pipe or a socket in it refuses it, so nothing
 * published points elsewhere on the host or shares its data.
 * @module fleet-tau/outputs
 */

import { randomUUID } from 'node:crypto'
import { cp, lstat, readdir, rename, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { SpecPath } from './spec.ts'

/** Most bytes one output may hold. */
export const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024

/**
 * What keeps a copy from being published, nothing when it is plain files and
 * folders within the size limit. A copy that is missing passes here; tau's
 * output check reports it.
 * @param name - the argument, which the problems name.
 * @param view - where the agent left it in the container, which the problems name.
 */
export async function copyProblems(copy: string, name: string, view: string, limit = MAX_OUTPUT_BYTES): Promise<string[]> {
  const problems: string[] = []
  let bytes = 0
  const visit = async (path: string): Promise<void> => {
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && path === copy) return
      throw error
    }
    const at = path === copy ? view : `${view}/${relative(copy, path)}`
    if (info.isSymbolicLink()) problems.push(`${name}: ${at} is a symlink, which fleet does not copy out`)
    else if (info.isDirectory()) for (const entry of (await readdir(path)).sort()) await visit(join(path, entry))
    else if (!info.isFile()) problems.push(`${name}: ${at} is neither a file nor a folder`)
    else if (info.nlink > 1) problems.push(`${name}: ${at} is a hard link, which fleet does not copy out`)
    else bytes += info.size
  }
  await visit(copy)
  if (bytes > limit) problems.push(`${name}: ${view} holds ${bytes} bytes, over the ${limit}-byte limit for an output`)
  return problems
}

/**
 * What tau's `checkOutputs` checks after a run: each `copy-out` path, here
 * its copy, and each `mount-rw` path is a file or a folder as declared,
 * symlinks followed.
 * @param copies - each copy-out's copy, by the path the agent left it at.
 * @returns a problem for each path that is missing or of the other kind.
 */
export async function outputProblems(paths: readonly SpecPath[], copies: Readonly<Record<string, string>>): Promise<string[]> {
  const problems: string[] = []
  for (const path of paths) {
    if (path.mode !== 'copy-out' && path.mode !== 'mount-rw') continue
    const at = path.mode === 'copy-out' ? copies[path.view] : path.host
    const info = at === undefined ? undefined : await stat(at).catch(() => undefined)
    const where = path.mode === 'copy-out' ? `the agent left nothing at ${path.view}` : `${path.host} is gone`
    if (info === undefined) problems.push(`${path.name}: ${where}`)
    else if (info.isDirectory() !== (path.kind === 'dir')) {
      problems.push(`${path.name}: ${path.mode === 'copy-out' ? path.view : path.host} is a ${info.isDirectory() ? 'folder' : 'file'}, not a ${path.kind === 'dir' ? 'folder' : 'file'}`)
    }
  }
  return problems
}

/**
 * Replace the caller's path with a checked copy, at once for a file; a
 * folder there is set aside first, since a rename cannot replace a folder
 * that holds anything, and removed once the copy is in place.
 */
export async function replace(host: string, copy: string): Promise<void> {
  const incoming = `${host}.fleet-${randomUUID()}`
  await cp(copy, incoming, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
  let setAside: string | undefined
  try {
    if ((await lstat(host).catch(() => undefined))?.isDirectory() === true) {
      setAside = `${host}.fleet-old-${randomUUID()}`
      await rename(host, setAside)
    }
    await rename(incoming, host)
  } catch (error) {
    if (setAside !== undefined) await rename(setAside, host).catch(() => {})
    await rm(incoming, { recursive: true, force: true })
    throw error
  }
  if (setAside !== undefined) await rm(setAside, { recursive: true, force: true })
}
