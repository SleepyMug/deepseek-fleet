/**
 * Publishing an agent's `out` paths: what the agent left in its
 * container, copied out to the store by fleet-box, which copies plain files
 * and folders only, is checked again here, and as tau checks a run's
 * outputs, and then put in place of the caller's path, outermost first.
 * The copy comes from the container, which the model controls, so it is
 * taken only as plain files and folders of bounded size: a symlink, a hard
 * link, a device, a pipe or a socket in it refuses it, so nothing published
 * points elsewhere on the host or shares its data.
 * @module fleet-core/tau/outputs
 */

import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, posix, relative } from 'node:path'
import type { SpecPath } from './spec.ts'

export { replace } from 'fleet-image/replace'

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
 * What tau's `checkOutputs` checks after a run: each `out` path, here its
 * copy, and each `share` path, the caller's own, is a file or a folder as
 * declared, symlinks followed. fleet-tau checks this itself, not with tau's
 * `checkOutputs`: tau's library loads TypeScript when it is imported, which
 * the host keeps to its worker, and a problem here names the path the agent
 * sees, never its copy in the store.
 * @param copyOf - where an out path's copy is.
 * @returns a problem for each path that is missing or not of its type.
 */
export async function outputProblems(paths: readonly SpecPath[], copyOf: (path: SpecPath) => string): Promise<string[]> {
  const problems: string[] = []
  for (const path of paths) {
    if (path.role === 'in') continue
    let info
    try {
      info = await stat(path.role === 'out' ? copyOf(path) : path.host)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') problems.push(`${path.name}: ${path.view} cannot be read: ${message(error)}`)
      else problems.push(`${path.name}: ${path.role === 'out' ? `the agent left nothing at ${path.view}` : `${path.view} is gone`}`)
      continue
    }
    if (path.type === 'dir' ? !info.isDirectory() : !info.isFile()) problems.push(`${path.name}: ${path.view} is not a ${path.type === 'dir' ? 'folder' : 'file'}`)
  }
  return problems
}

/**
 * Where each `out` path is published, and in what order. Each is found
 * before any is published: on the host, its folder as the host resolves it,
 * and its own name, which the publish replaces, not followed; so publishing
 * one cannot move where another goes. In a caller's container, which the
 * host never reads, it is the path as given. They go outermost first, and
 * those at the same path in their order, so that each exists once all are
 * published (tau's SPEC.md); where two share a path, the later one wins.
 * @param onHost - whether the caller's paths are the host's, or else a container's.
 */
export async function publishTargets<Path extends Pick<SpecPath, 'host'>>(outputs: readonly Path[], onHost = true): Promise<{ path: Path; at: string }[]> {
  const targets = await Promise.all(outputs.map(async (path) => {
    if (!onHost) return { path, at: posix.normalize(path.host) }
    const folder = await realpath(dirname(path.host)).catch(() => dirname(path.host))
    return { path, at: join(folder, basename(path.host)) }
  }))
  return targets.toSorted((a, b) => a.at.split('/').length - b.at.split('/').length)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
