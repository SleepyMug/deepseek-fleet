/**
 * Where a session's container shows its agent and the agent's path
 * arguments, and the paths it cannot take. The agent's snapshot is copied to
 * /tau/agent, which the prompt names as `${self}`. The agent works in a
 * folder of the container's own that has its project's path (./store.ts),
 * where tau puts each path argument at its place, as tau.json declares it,
 * and the prompt names it there: an `in` path is a snapshot copied there, and
 * an `out` path is what the agent leaves there, which is copied out once the
 * run completes. Nothing else of the caller's is in the container.
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
import { TAU_ROOT } from 'fleet-image/layout'

/** Where a session's container sees its agent's snapshot. */
export const AGENT_VIEW = `${TAU_ROOT}/agent`

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
