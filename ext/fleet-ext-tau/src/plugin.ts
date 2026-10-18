/**
 * fleet-ext-tau, an extension of the fleet host (fleet-core's
 * docs/fleet-core/ext/index.md), as a dsh plugin: it provides the contract
 * @sleepymug/tau-api, the tau API of tau's docs/spec/tau-api.md, whose client
 * (./client/index.ts) a tau's programs import by the contract's name, and
 * whose server (./tau.ts) starts,
 * finishes and cancels the runs a tau's session starts from its box, on the
 * tau service, `ctx.fleetTau`.
 * @module @sleepymug/fleet-ext-tau/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineExt, type Implements, provideExt } from '@sleepymug/fleet-core/ext/define'
import type {} from '@sleepymug/fleet-core/services'
import type * as Contract from '@sleepymug/tau-api'
import { CONTRACT } from './client/contract.ts'
import type * as Client from './client/index.ts'
import { methods } from './tau.ts'

export const name = 'fleet-ext-tau'
export const inject = ['fleetExts', 'fleetTau']

/** The contract, at the version this package depends on, and is built against, and the client's folder, as built. */
export const EXT = defineExt(import.meta.url, CONTRACT)

/** The client implements the contract, as TypeScript checks while this package is built. */
export type Implemented = Implements<typeof Contract, typeof Client>

export function apply(ctx: Context): void {
  provideExt(ctx, { ...EXT, methods: methods(ctx.fleetTau) })
}
