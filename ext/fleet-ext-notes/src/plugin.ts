/**
 * fleet-ext-notes, an extension of the fleet host (fleet-core's
 * docs/fleet-core/ext/index.md), as a dsh plugin: it provides the contract
 * @sleepymug/tau-api-notes, whose client (./client/index.ts) a tau's
 * programs import by the contract's name, and whose server
 * (./notes.ts) keeps each session's notebook in the dsh home.
 * @module @sleepymug/fleet-ext-notes/plugin
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineExt, type Implements, provideExt } from '@sleepymug/fleet-core/ext/define'
import { fleetPaths } from '@sleepymug/fleet-core/paths'
import type * as Contract from '@sleepymug/tau-api-notes'
import { CONTRACT } from './client/contract.ts'
import type * as Client from './client/index.ts'
import { Notebooks } from './notes.ts'

/** The client implements the contract, as TypeScript checks while this package is built. */
export type Implemented = Implements<typeof Contract, typeof Client>

export const name = 'fleet-ext-notes'
export const inject = ['fleetExts']

/** The contract, at the version this package depends on, and is built against, and the client's folder, as built. */
export const EXT = defineExt(import.meta.url, CONTRACT)

export interface Config {
  /** The dsh home, absolute, where the notebooks are kept, in fleet/notes/. */
  dshHome: string
}

export function apply(ctx: Context, config: Config): void {
  const notebooks = new Notebooks(join(fleetPaths(config?.dshHome, name).fleet, 'notes'))
  provideExt(ctx, { ...EXT, methods: notebooks.methods })
}
