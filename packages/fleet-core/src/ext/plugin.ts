/**
 * fleet-exts, the extensions provided to the fleet host (./exts.ts), as a
 * dsh plugin that provides them as `ctx.fleetExts`. It needs nothing, so the
 * runs of taus, which link them, build on it, and so does each extension's
 * own plugin, which imports this module's types for `ctx.fleetExts`.
 * @module fleet-core/ext/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { FleetExts } from './exts.ts'

export type { CallContext, Ext, ExtMethod, FleetExts } from './exts.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetExts: FleetExts
  }
}

export const name = 'fleet-exts'

export function apply(ctx: Context): void {
  ctx.provide('fleetExts', new FleetExts())
}
