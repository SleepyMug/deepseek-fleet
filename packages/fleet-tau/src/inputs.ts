/**
 * Snapshotting an agent's `in` paths when its session is made: each is
 * copied into the session's folder in the store, and the container mounts
 * the copy read-only where the caller has the path. The caller's path is
 * followed if it is a symlink, as tau follows it; a symlink inside it is
 * copied as the link it is, as a mount would show it, never as what it
 * leads to, which could be anywhere on the host. A copy is plain files,
 * folders and symlinks, so a device, a pipe or a socket in it refuses it.
 * Each folder keeps its mode, but stays writable by its owner, so the store
 * can remove it.
 * @module fleet-tau/inputs
 */

import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'

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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
