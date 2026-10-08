/**
 * fleet-ext-notes, an extension of the fleet host (fleet-core's
 * docs/fleet-core/ext/index.md), as a dsh plugin: it provides the notes API,
 * whose client (./client/index.ts) a tau's programs import as `@api/notes`,
 * and whose server (./notes.ts) keeps each session's notebook here.
 * @module @sleepymug/fleet-ext-notes/plugin
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@sleepymug/fleet-core/ext/plugin'
import { Notebooks } from './notes.ts'

export const name = 'fleet-ext-notes'
export const inject = ['fleetExts']

/** The client's folder, as built: index.js, with its declarations beside it. */
export const CLIENT = fileURLToPath(new URL('./client/', import.meta.url))

export function apply(ctx: Context): void {
  const notebooks = new Notebooks()
  ctx.effect(() => ctx.fleetExts.provide({ api: 'notes', client: CLIENT, methods: notebooks.methods }), 'fleet-ext-notes')
}
