/**
 * What every extension's plugin does (docs/fleet-core/ext/index.md): find
 * its client, built in client/ beside the plugin's module; read the version
 * of the contract it implements from the contract's package, which the
 * extension depends on at that version, and whose folder holds its
 * declarations; check, as it is built, that the
 * client implements the contract; and provide itself, for as long as its
 * plugin is loaded:
 *
 * ```ts
 * export const EXT = defineExt(import.meta.url, CONTRACT)
 * export type Implemented = Implements<typeof Contract, typeof Client>
 * export function apply(ctx: Context) { provideExt(ctx, { ...EXT, methods }) }
 * ```
 * @module @sleepymug/fleet-core/ext/define
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../services.ts'
import type { Ext } from './exts.ts'

/**
 * An extension, but for its server's methods, as its package has it: the
 * contract, at the version the package depends on, the folder of the
 * contract's package, and the client's folder, client/ beside the plugin's
 * module.
 * @param url - the plugin's module, `import.meta.url`.
 * @param contract - the contract the client implements, by its package's name.
 */
export function defineExt(url: string, contract: string): Omit<Ext, 'methods'> {
  const manifest = createRequire(url).resolve(`${contract}/package.json`)
  return {
    contract,
    version: (JSON.parse(readFileSync(manifest, 'utf8')) as { version: string }).version,
    client: fileURLToPath(new URL('./client/', url)),
    declarations: dirname(manifest),
  }
}

/** Provide an extension, `ctx.fleetExts.provide`, for as long as the plugin whose context it is is loaded. */
export function provideExt(ctx: Context, ext: Ext): void {
  ctx.effect(() => ctx.fleetExts.provide(ext), `fleet ext ${ext.contract}`)
}

/**
 * The client, if it implements the contract, which TypeScript checks as
 * the extension's package is built: `Implements<typeof Contract, typeof Client>`,
 * of the contract's package and the client's module.
 */
export type Implements<Contract, Client extends Contract> = Client
