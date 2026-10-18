/**
 * The APIs of a run of a tau (tau's docs/spec/implementations.md): the
 * extensions provided, as the catalog in which tau's backend SDK finds the
 * implementation of each API the tau names, a contract and a range: the
 * extension that implements the contract, at a version within the range,
 * whose client, and the contract's declarations, are copied into the run's
 * box; and the contracts the tau service gives a tau's author. A tau with
 * an API no extension serves is refused before anything is made.
 * @module @sleepymug/fleet-core/tau/apis
 */

import type { ImplementationCatalog } from '@sleepymug/tau/backend'
import { within } from '@sleepymug/tau/core'
import type { Ext } from '../ext/exts.ts'

/** The extensions provided, as the runs look them up. */
export interface Exts {
  get(contract: string): Ext | undefined
}

/**
 * The extensions as a catalog: each implementation's module is its
 * extension's client's folder, on the host, and its declarations the
 * folder of the contract's package.
 */
export function catalogOf(exts: Exts): ImplementationCatalog {
  return {
    find(contract, range) {
      const ext = exts.get(contract)
      return ext !== undefined && (range === undefined || within(ext.version, range))
        ? { contract, version: ext.version, module: ext.client, declarations: ext.declarations }
        : undefined
    },
  }
}
