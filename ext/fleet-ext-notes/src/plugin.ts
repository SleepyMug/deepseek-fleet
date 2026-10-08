/**
 * fleet-ext-notes, an extension of the fleet host (fleet-core's
 * docs/fleet-core/ext/index.md), as a dsh plugin: it provides the contract
 * @sleepymug/tau-api-notes, whose client (./client/index.ts) a tau's
 * programs import as the API that holds a copy of it, and whose server
 * (./notes.ts) keeps each session's notebook in the dsh home.
 * @module @sleepymug/fleet-ext-notes/plugin
 */

import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@sleepymug/fleet-core/ext/plugin'
import type * as Contract from '@sleepymug/tau-api-notes'
import { CONTRACT } from './client/contract.ts'
import type * as Client from './client/index.ts'
import { Notebooks } from './notes.ts'

/** The client implements the contract, as TypeScript checks while this package is built. */
export type Implemented = Implements<typeof Client>
type Implements<T extends typeof Contract> = T

export const name = 'fleet-ext-notes'
export const inject = ['fleetExts']

/** The client's folder, as built: index.js, with its declarations beside it. */
export const CLIENT = fileURLToPath(new URL('./client/', import.meta.url))

/** The version of the contract the client implements: the one this package depends on, and is built against. */
export const VERSION = (createRequire(import.meta.url)(`${CONTRACT}/package.json`) as { version: string }).version

export interface Config {
  /** The dsh home, absolute, where the notebooks are kept, in fleet/notes/. */
  dshHome: string
}

export function apply(ctx: Context, config: Config): void {
  if (typeof config?.dshHome !== 'string' || !isAbsolute(config.dshHome)) {
    throw new Error('fleet-ext-notes: its config names dshHome, the dsh home, an absolute path')
  }
  const notebooks = new Notebooks(join(config.dshHome, 'fleet', 'notes'))
  ctx.effect(() => ctx.fleetExts.provide({ contract: CONTRACT, version: VERSION, client: CLIENT, methods: notebooks.methods }), 'fleet-ext-notes')
}
