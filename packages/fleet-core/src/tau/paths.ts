/**
 * Where a session's container shows its agent and the agent's path
 * arguments, which tau leaves to the runtime, and the arguments it cannot
 * give. The agent's snapshot is copied to /tau/agent. An `in` path is a
 * snapshot copied into /tau/in/<name>/, and an `out` path is made in
 * /tau/out/<name>/, each keeping the base name of the caller's path, so
 * neither meets the caller's paths or the container's own, and the prompt
 * names them there. A `share` path is the caller's own, which the agent
 * changes as the caller sees it, so the container mounts it where the
 * caller has it; it may not cover or replace the container's system folders
 * or fleet's own.
 *
 * The session folder is no argument but the agent's working folder, which
 * fleet-box mounts at its own path. A `share` path in it is there already,
 * unless it leads out of it through a symlink, which the container resolves
 * among its own files; one that holds it cannot be mounted over it; and an
 * `out` path that is or holds it would replace it when published. No path
 * may be, hold or lie in the dsh home either, where fleet keeps its
 * sessions, which a snapshot would copy into itself. Paths are compared as
 * given, which is where the container shows them, and as the host resolves
 * them, through symlinks.
 * @module fleet-core/tau/paths
 */

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'
import type { BoundPath } from '@sleepymug/tau'
import { PACKAGE_ROOT, RUN_ROOT, TAU_ROOT } from 'fleet-image/layout'
import type { Mount } from '../box/additions.ts'

/** Where a session's container sees its agent's snapshot. */
export const AGENT_VIEW = `${TAU_ROOT}/agent`

/** Folders a `share` path may neither be nor hold: the system's, and fleet's own. */
const COVERED = ['/bin', '/sbin', '/lib', '/lib64', '/usr', '/etc', '/var', PACKAGE_ROOT, TAU_ROOT, RUN_ROOT]
/** Folders a `share` path may not lie in either: the kernel's, and fleet's own. */
const ENCLOSED = ['/proc', '/sys', '/dev', PACKAGE_ROOT, TAU_ROOT, RUN_ROOT]

/** Where the container shows a path argument, and the prompt names it; tau's `place`. */
export function place(path: Omit<BoundPath, 'view'>): string {
  if (path.role === 'share') return path.host
  return posix.join(TAU_ROOT, path.role, path.name, posix.basename(path.host))
}

/**
 * The mount a `share` path that {@link pathProblems} accepts needs: none
 * when the session folder's own mount shows it already.
 * @param sessionFolder - the session folder, as its real path.
 */
export function shareMount(path: Pick<BoundPath, 'host' | 'view'>, sessionFolder: string): Mount | undefined {
  return within(path.host, sessionFolder) ? undefined : { source: path.host, target: path.view, readonly: false }
}

/**
 * @param paths - the bound path arguments.
 * @param sessionFolder - the session folder, as its real path.
 * @param dshHome - the dsh home, where fleet keeps its sessions.
 * @returns a problem for each path the container cannot be given.
 */
export function pathProblems(paths: readonly Pick<BoundPath, 'name' | 'role' | 'host'>[], sessionFolder: string, dshHome: string): string[] {
  const home = realPath(dshHome)
  const problems: string[] = []
  for (const path of paths) {
    const real = realPath(path.host)
    const touching = relation(path.host, dshHome) ?? relation(real, home)
    if (touching !== undefined) {
      problems.push(`${path.name}: ${path.host} ${touching} the dsh home ${dshHome}, where fleet keeps its sessions`)
      continue
    }
    if (path.role === 'out' && (within(sessionFolder, path.host) || within(sessionFolder, real))) {
      problems.push(`${path.name}: ${path.host} is or holds the session folder ${sessionFolder}, which publishing it would replace`)
      continue
    }
    if (path.role === 'share') {
      const problem = shareProblem(path.host, real, sessionFolder)
      if (problem !== undefined) problems.push(`${path.name}: ${path.host} ${problem}`)
    }
  }
  return problems
}

/** Why the container cannot be given a `share` path, if it cannot. */
function shareProblem(host: string, real: string, sessionFolder: string): string | undefined {
  if (within(host, sessionFolder)) {
    return within(real, sessionFolder) ? undefined
      : `lies in the session folder ${sessionFolder} but leads out of it through a symlink, which the container resolves among its own files`
  }
  const covered = COVERED.find(folder => within(folder, host))
  if (covered !== undefined) return `would cover ${covered} in the container`
  const enclosing = ENCLOSED.find(folder => within(host, folder))
  if (enclosing !== undefined) return `lies in ${enclosing}, which the container keeps for itself`
  if (within(sessionFolder, host)) {
    return `holds the session folder ${sessionFolder}, which the container mounts on its own; run the agent in ${host}, or in a folder outside it, with --cwd`
  }
  return undefined
}

/** How `path` meets `folder`: is it, holds it or lies in it; undefined when it does none. */
function relation(path: string, folder: string): 'is' | 'holds' | 'lies in' | undefined {
  if (path === folder) return 'is'
  if (within(folder, path)) return 'holds'
  if (within(path, folder)) return 'lies in'
  return undefined
}

/** Whether `inner` is `outer` or lies in it. */
function within(inner: string, outer: string): boolean {
  return inner === outer || outer === '/' || inner.startsWith(`${outer}/`)
}

/** A path as the host resolves it; for one not made yet, its folder's real path and its name. */
function realPath(path: string): string {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  return parent === path ? path : join(realPath(parent), basename(path))
}
