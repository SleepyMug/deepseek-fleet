/**
 * dsh's tool-fs, read/write/edit and read_image, as the `tau` agent preset's
 * `box` group mounts it, where `fs` is isolated, the box's.
 *
 * tool-fs registers read_image in a nested `ctx.inject(['attachments'], …)`,
 * whose fiber reads `ctx.fs` without injecting it, so that cordis looks for
 * it up the fibers above. cordis 4.0.4 compares the isolation key of each
 * fiber it passes with the root context's, not the caller's, so under an
 * isolated `fs` it stops at the group and read_image fails with `cannot get
 * property "fs" without inject`. This plugin is tool-fs, but each nested
 * inject of tool-fs's also requires tool-fs's own services, which its fiber
 * then holds itself, so no lookup has to go up. Those services are already
 * tool-fs's, so the nested fiber starts and stops as it would. To be dropped
 * once cordis looks up with the caller's key.
 * @module @sleepymug/fleet-core/preset/tool-fs
 */

import type { Context, Inject } from '@deepseek-ai/cordis'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'

export const name = 'fleet-tau-tool-fs'
export const inject = toolFs.inject
export const Config = toolFs.Config

/** `deps` with `extra` added, in either form cordis takes. */
export function withDeps(deps: Inject, extra: readonly string[]): Inject {
  if (Array.isArray(deps)) return [...new Set([...deps, ...extra])]
  const added = Object.fromEntries(extra.filter(name => !(name in deps)).map(name => [name, null]))
  return { ...deps, ...added }
}

export function apply(ctx: Context, config: toolFs.Config): void {
  const shim = ctx.extend({
    inject: (deps: Inject, callback: Parameters<Context['inject']>[1]) => ctx.inject(withDeps(deps, toolFs.inject), callback),
  })
  toolFs.apply(shim, config)
}
