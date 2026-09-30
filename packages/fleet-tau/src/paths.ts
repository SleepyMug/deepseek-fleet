/**
 * Where an agent's path arguments may appear in its container, which sees
 * each where the caller has it. Running a tau in fleet is a transformation
 * of it: the session folder is an implicit `inout` folder argument, which
 * the container mounts already. tau refuses a path that is, holds or lies
 * in another, so a declared path that does so with the session folder is
 * refused too, compared as the host resolves it, through symlinks, and as
 * given, which is where the container mounts it. A path may not cover or
 * replace the container's system folders or fleet's own either.
 * @module fleet-tau/paths
 */

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { BoundPath } from '@sleepymug/tau'

/** Folders a path may neither be nor hold: the system's, and fleet's own. */
const COVERED = ['/bin', '/sbin', '/lib', '/lib64', '/usr', '/etc', '/var', '/opt/fleet-box', '/opt/fleet-tau', '/run/fleet-box']
/** Folders a path may not lie in either: the kernel's, and fleet's own. */
const ENCLOSED = ['/proc', '/sys', '/dev', '/opt/fleet-box', '/opt/fleet-tau', '/run/fleet-box']

/**
 * @param paths - the bound path arguments.
 * @param cwd - the session folder, as its real path.
 * @returns a problem for each path the container cannot be given.
 */
export function pathProblems(paths: readonly Pick<BoundPath, 'name' | 'host'>[], cwd: string): string[] {
  const problems: string[] = []
  for (const path of paths) {
    if (overlaps(realPath(path.host), cwd) || overlaps(path.host, cwd)) {
      problems.push(`${path.name}: ${path.host} is, holds or lies in the session folder ${cwd}, which the container mounts already; `
        + 'give a path outside it, or run the agent in another folder with --cwd')
      continue
    }
    const covered = COVERED.find(folder => within(folder, path.host))
    if (covered !== undefined) {
      problems.push(`${path.name}: ${path.host} would cover ${covered} in the container`)
      continue
    }
    const enclosing = ENCLOSED.find(folder => within(path.host, folder))
    if (enclosing !== undefined) problems.push(`${path.name}: ${path.host} lies in ${enclosing}, which the container keeps for itself`)
  }
  return problems
}

/** Whether `inner` is `outer` or lies in it. */
function within(inner: string, outer: string): boolean {
  return inner === outer || outer === '/' || inner.startsWith(`${outer}/`)
}

function overlaps(a: string, b: string): boolean {
  return within(a, b) || within(b, a)
}

/** A path as the host resolves it; for one not made yet, its folder's real path and its name. */
function realPath(path: string): string {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  return parent === path ? path : join(realPath(parent), basename(path))
}
