/**
 * fleet-ext-tau, an extension of the fleet host (fleet-core's
 * docs/fleet-core/ext/index.md), as a dsh plugin: it provides the contract
 * @sleepymug/tau-api, the tau API of tau's docs/spec/tau-api.md, whose client
 * (./client/index.ts) a tau's programs import as the API that holds a copy
 * of it, by convention `@api/tau`, and whose server (./tau.ts) starts,
 * finishes and cancels the runs a tau's session starts from its box, on the
 * tau service, `ctx.fleetTau`.
 * @module @sleepymug/fleet-ext-tau/plugin
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@sleepymug/fleet-core/ext/plugin'
import type {} from '@sleepymug/fleet-core/tau/plugin'
import type * as Contract from '@sleepymug/tau-api'
import { CONTRACT } from './client/contract.ts'
import type * as Client from './client/index.ts'
import { methods } from './tau.ts'

export const name = 'fleet-ext-tau'
export const inject = ['fleetExts', 'fleetTau']

/** The client's folder, as built: index.js, with its declarations beside it. */
export const CLIENT = fileURLToPath(new URL('./client/', import.meta.url))

/** The version of the contract the client implements: the one this package depends on, and is built against. */
export const VERSION = (createRequire(import.meta.url)(`${CONTRACT}/package.json`) as { version: string }).version

/** The client implements the contract, as TypeScript checks while this package is built. */
export type Implemented = Implements<typeof Client>
type Implements<T extends typeof Contract> = T

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.fleetExts.provide({ contract: CONTRACT, version: VERSION, client: CLIENT, methods: methods(ctx.fleetTau) }), 'fleet-ext-tau')
}
