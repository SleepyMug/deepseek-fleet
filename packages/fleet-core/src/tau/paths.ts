/**
 * Where a session's container shows its agent and the agent's path
 * arguments, and the paths it cannot give. The agent's snapshot is copied to
 * /tau/agent, which the prompt names as `${self}`. The agent works in a
 * folder of the container's own that has its project's path (./store.ts),
 * where tau puts each path argument at its place, as tau.json declares it,
 * and the prompt names it there: an `in` path is a snapshot copied there, and
 * an `out` path is what the agent leaves there, which is copied out once the
 * run completes. Nothing else of the caller's is in the container.
 *
 * A place may not be, hold or lie in the container's system folders, the
 * kernel's or fleet's own, as it would in a project at such a path, or at
 * `/`: a copy there could replace what the container runs on.
 *
 * The caller's paths may overlap each other, but none may be, hold or lie in
 * the dsh home, where fleet keeps its sessions: a snapshot would copy it into
 * itself, and a publish could replace it. Each path is compared with the dsh
 * home as given and as the host resolves it, but for an `out` path's own
 * name, which the publish replaces, not follows.
 *
 * A run started inside a session's container (./children.ts) works in its
 * caller's project, and places its paths as any run does, while the caller's
 * paths are in the caller's container, which the host never resolves.
 * @module fleet-core/tau/paths
 */

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { BoundPath } from '@sleepymug/tau'
import { PACKAGE_ROOT, RUN_ROOT, TAU_ROOT } from 'fleet-image/layout'

/** Where a session's container sees its agent's snapshot. */
export const AGENT_VIEW = `${TAU_ROOT}/agent`

/** Folders a place may not be, hold or lie in: the system's, the kernel's, and fleet's own. */
const KEPT = ['/bin', '/sbin', '/lib', '/lib64', '/usr', '/etc', '/var', '/proc', '/sys', '/dev', PACKAGE_ROOT, TAU_ROOT, RUN_ROOT]

/** @returns a problem for each path argument whose place, its view, the container cannot give it. */
export function placeProblems(paths: readonly Pick<BoundPath, 'name' | 'view'>[]): string[] {
  return paths.flatMap(({ name, view }) => {
    const covered = KEPT.find(folder => within(folder, view))
    if (covered !== undefined) return [`${name}: its place ${view} would cover ${covered} in the container`]
    const enclosing = KEPT.find(folder => within(view, folder))
    if (enclosing !== undefined) return [`${name}: its place ${view} lies in ${enclosing}, which the container keeps for itself`]
    return []
  })
}

/**
 * @param paths - the bound path arguments of a run started on the host.
 * @param dshHome - the dsh home, where fleet keeps its sessions.
 * @returns a problem for each of the caller's paths that is, holds or lies in the dsh home.
 */
export function pathProblems(paths: readonly Pick<BoundPath, 'name' | 'role' | 'host'>[], dshHome: string): string[] {
  const home = realPath(dshHome)
  return paths.flatMap((path) => {
    const real = path.role === 'out' ? join(realPath(dirname(path.host)), basename(path.host)) : realPath(path.host)
    const touching = relation(path.host, dshHome) ?? relation(real, home)
    return touching === undefined ? [] : [`${path.name}: ${path.host} ${touching} the dsh home ${dshHome}, where fleet keeps its sessions`]
  })
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
