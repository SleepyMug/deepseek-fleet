/**
 * fleet-ext-tau, an extension of the fleet host (fleet-core's
 * docs/fleet-core/ext/index.md), as a dsh plugin: it provides the `tau` API
 * of tau's docs/spec/tau-api.md, whose client (./client/index.ts) a tau's
 * programs import as `@api/tau`, and whose server (./tau.ts) starts, finishes
 * and cancels the runs a tau's session starts from its box, on the tau
 * service, `ctx.fleetTau`.
 * @module @sleepymug/fleet-ext-tau/plugin
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@sleepymug/fleet-core/ext/plugin'
import type {} from '@sleepymug/fleet-core/tau/plugin'
import { methods } from './tau.ts'

export const name = 'fleet-ext-tau'
export const inject = ['fleetExts', 'fleetTau']

/** The client's folder, as built: index.js, with its declarations beside it. */
export const CLIENT = fileURLToPath(new URL('./client/', import.meta.url))

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.fleetExts.provide({ api: 'tau', client: CLIENT, methods: methods(ctx.fleetTau) }), 'fleet-ext-tau')
}
