/**
 * Snapshotting an agent's `in` paths when its session is made: each is
 * copied into the session's folder in the store, and fleet-box copies the
 * snapshot into each of the session's containers, at its place
 * (./paths.ts), when it creates the container. The caller's path is followed if it
 * is a symlink, as tau follows it; a symlink inside it is copied as the link
 * it is, never as what it leads to, which could be anywhere on the host. A
 * copy is plain files, folders and symlinks, so a device, a pipe or a socket
 * in it refuses it. Each folder keeps its mode, but stays writable by its
 * owner, so the store can remove it.
 *
 * For a run started inside a session's container, the caller's paths are in
 * that container, the model's, so they are never read on the host: each `in`
 * path is copied out of the container through its helper, in the same way,
 * and its type and the folders of its `out` paths are checked there, as tau
 * checks a run's inputs, symlinks followed.
 * @module fleet-core/tau/inputs
 */

import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, symlink } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { FleetBox } from '../box/world.ts'
import type { SpecPath } from './spec.ts'

/** An `in` path that could not be copied: what the caller gave, not a failure of fleet's own. */
export class InputError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'))
    this.name = 'InputError'
  }
}

/**
 * Copy the caller's `in` path to `copy`, which does not exist yet.
 * @param name - the argument, which the problems name.
 * @returns a problem for each part that could not be copied, none when all was.
 */
export async function snapshot(name: string, host: string, copy: string, signal?: AbortSignal): Promise<string[]> {
  const problems: string[] = []
  const visit = async (source: string, target: string, shown: string): Promise<void> => {
    signal?.throwIfAborted()
    try {
      const info = await lstat(source)
      if (info.isSymbolicLink()) await symlink(await readlink(source), target)
      else if (info.isFile()) await copyFile(source, target, constants.COPYFILE_EXCL)
      else if (info.isDirectory()) {
        await mkdir(target, { mode: 0o700 })
        for (const entry of (await readdir(source)).sort()) await visit(join(source, entry), join(target, entry), `${shown}/${entry}`)
        await chmod(target, (info.mode & 0o777) | 0o700)
      }
      else problems.push(`${name}: ${shown} is neither a file, a folder nor a symlink, which fleet does not copy in`)
    } catch (error) {
      if (signal?.aborted === true) throw error
      problems.push(`${name}: could not copy ${shown}: ${message(error)}`)
    }
  }
  let root: string
  try {
    root = await realpath(host)
  } catch (error) {
    return [`${name}: could not copy ${host}: ${message(error)}`]
  }
  await visit(root, copy, host)
  return problems
}

/** What fleet-box gives of the caller's container. */
export type CallerContainer = Pick<FleetBox, 'copyOut' | 'pathType'>

/**
 * Copy an `in` path of a run started inside a container out of the
 * caller's container to `copy`, which does not exist yet, and check its type.
 * @param caller - the session whose container has the caller's paths.
 * @returns the problems, none when it was copied and is of its type.
 */
export async function snapshotFrom(box: CallerContainer, caller: SessionId, path: SpecPath, copy: string, signal?: AbortSignal): Promise<string[]> {
  try {
    if (!await box.copyOut(caller, path.host, copy, { links: true, ...signal === undefined ? {} : { signal } })) return [`${path.name}: ${path.host} ${MISSING}`]
  } catch (error) {
    if (signal?.aborted === true) throw error
    return [`${path.name}: could not copy ${path.host}: ${message(error)}`]
  }
  // What the path led to was copied, so a symlink here is one that led nowhere in the container; it is never followed on the host.
  const info = await lstat(copy)
  if (info.isSymbolicLink()) return [`${path.name}: ${path.host} ${MISSING}`]
  return (path.type === 'dir' ? info.isDirectory() : info.isFile()) ? [] : [`${path.name}: ${path.host} is not a ${path.type === 'dir' ? 'directory' : 'file'}`]
}

/**
 * What keeps the `out` paths of a run started inside a container from
 * fitting, in the caller's container, as tau's `checkInputs` checks them:
 * each goes into an existing folder, and is not there yet, or is of its own
 * type.
 * @param caller - the session whose container has the caller's paths.
 */
export async function outputFolderProblems(box: CallerContainer, caller: SessionId, paths: readonly SpecPath[], signal?: AbortSignal): Promise<string[]> {
  const problems: string[] = []
  for (const path of paths.filter(each => each.role === 'out')) {
    const parent = posix.dirname(path.host)
    const folder = await box.pathType(caller, parent, signal)
    if (folder !== 'directory') {
      problems.push(`${path.name}: cannot go in ${parent}, which ${folder === undefined ? MISSING : 'is not a directory'}`)
      continue
    }
    const there = await box.pathType(caller, path.host, signal)
    if (there !== undefined && there !== (path.type === 'dir' ? 'directory' : 'file')) {
      problems.push(`${path.name}: ${path.host} is not a ${path.type === 'dir' ? 'directory' : 'file'}`)
    }
  }
  return problems
}

const MISSING = 'does not exist'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
