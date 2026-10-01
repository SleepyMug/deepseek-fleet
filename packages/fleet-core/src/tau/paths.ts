/**
 * Where a session's container shows its agent and the agent's path
 * arguments, which tau leaves to the runtime, and the arguments it cannot
 * give. The agent's snapshot is copied to /tau/agent, which the prompt names
 * as `${self}`. An `in` path is a snapshot copied into /tau/in/<name>/, and
 * an `out` path is made in /tau/out/<name>/, each keeping the base name of
 * the caller's path, so neither meets the caller's paths or the container's
 * own, and the prompt names them there. A `share` path is the caller's own,
 * which the agent changes as the caller sees it, so the container mounts it
 * at its real path, the same in the container as on the host, as fleet-box
 * mounts the workspace dir: such mounts show the same files where they
 * meet, so `share` paths may lie in the workspace dir or in each other, or
 * hold them, and symlinks between them lead where they do on the host.
 * Where it really is, though, a `share` path may not be or hold the
 * container's system folders or fleet's own, nor lie in the kernel's or
 * fleet's.
 *
 * Paths may overlap each other and the workspace dir, but none may be, hold or
 * lie in the dsh home, where fleet keeps its sessions: a snapshot would copy it
 * into itself, a publish could replace it, and a mount would show the agent
 * every session. Each path is compared with the dsh home as given and as the
 * host resolves it, but for an `out` path's own name, which the publish
 * replaces, not follows.
 *
 * A run started inside a session's container (./children.ts) works in
 * {@link NESTED_CWD}, its own container's, with nothing mounted, and its
 * `in` and `out` paths are placed as any run's are, while the caller's paths
 * are in the caller's container. A `share` path there would name the caller's
 * files in its container, which no other container can mount, so such a run
 * takes none: only a functional tau runs inside a container.
 * @module fleet-core/tau/paths
 */

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'
import type { BoundPath } from '@sleepymug/tau'
import { PACKAGE_ROOT, RUN_ROOT, TAU_ROOT } from 'fleet-image/layout'
import type { Mount } from '../box/additions.ts'

/** Where a session's container sees its agent's snapshot. */
export const AGENT_VIEW = `${TAU_ROOT}/agent`

/** The folder a run started inside a container works in, its own container's. */
export const NESTED_CWD = '/workspace'

/** Folders a `share` path may neither be nor hold: the system's, and fleet's own. */
const COVERED = ['/bin', '/sbin', '/lib', '/lib64', '/usr', '/etc', '/var', PACKAGE_ROOT, TAU_ROOT, RUN_ROOT]
/** Folders a `share` path may not lie in either: the kernel's, and fleet's own. */
const ENCLOSED = ['/proc', '/sys', '/dev', PACKAGE_ROOT, TAU_ROOT, RUN_ROOT]

/** Where the container shows a path argument, and the prompt names it; tau's `place`. */
export function place(path: Omit<BoundPath, 'view'>): string {
  if (path.role === 'share') return realPath(path.host)
  return posix.join(TAU_ROOT, path.role, path.name, posix.basename(path.host))
}

/** The mount that shows a `share` path {@link pathProblems} accepts: its real path, at the same path. */
export function shareMount(path: Pick<BoundPath, 'view'>): Mount {
  return { source: path.view, target: path.view, readonly: false }
}

/**
 * Where the container of a run started inside another shows a path
 * argument: an `in` or `out` path as {@link place} puts it, and a `share`
 * path, which {@link nestedPathProblems} refuses, where the caller has it.
 */
export function placeNested(path: Omit<BoundPath, 'view'>): string {
  return path.role === 'share' ? path.host : place(path)
}

/** @returns a problem for each path argument a run started inside a container cannot be given: its `share` paths. */
export function nestedPathProblems(paths: readonly Pick<BoundPath, 'name' | 'role' | 'host'>[]): string[] {
  return paths.filter(path => path.role === 'share').map(path => `${path.name}: ${path.host} is a share path, which a run started in a `
    + 'container cannot take: no other container can mount the caller\'s files, so only a tau without share paths runs here')
}

/**
 * @param paths - the bound path arguments, placed by {@link place}.
 * @param dshHome - the dsh home, where fleet keeps its sessions.
 * @returns a problem for each path the container cannot be given.
 */
export function pathProblems(paths: readonly Pick<BoundPath, 'name' | 'role' | 'host' | 'view'>[], dshHome: string): string[] {
  const home = realPath(dshHome)
  const problems: string[] = []
  for (const path of paths) {
    const real = path.role === 'out' ? join(realPath(dirname(path.host)), basename(path.host)) : realPath(path.host)
    const touching = relation(path.host, dshHome) ?? relation(real, home)
    if (touching !== undefined) {
      problems.push(`${path.name}: ${path.host} ${touching} the dsh home ${dshHome}, where fleet keeps its sessions`)
      continue
    }
    const problem = path.role === 'share' ? mountProblem(path.view) : undefined
    if (problem !== undefined) problems.push(`${path.name}: ${path.view === path.host ? path.host : `${path.host}, which is ${path.view},`} ${problem}`)
  }
  return problems
}

/** Why the container cannot show a host path at the same path, if it cannot. */
function mountProblem(real: string): string | undefined {
  const covered = COVERED.find(folder => within(folder, real))
  if (covered !== undefined) return `would cover ${covered} in the container`
  const enclosing = ENCLOSED.find(folder => within(real, folder))
  if (enclosing !== undefined) return `lies in ${enclosing}, which the container keeps for itself`
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
