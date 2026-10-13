/**
 * The APIs of a run of a tau (tau's docs/spec/implementations.md): the
 * extensions provided, as the catalog in which tau's backend SDK finds the
 * implementation of each API the tau holds, a copy of a contract: the
 * extension that implements the contract, at a version that serves the
 * copy's, whose client is copied into the run's box. A tau with an API no
 * extension serves is refused before anything is made.
 * @module @sleepymug/fleet-core/tau/apis
 */

import type { ImplementationCatalog } from '@sleepymug/tau/backend'
import { serves } from '@sleepymug/tau/core'
import type { Ext } from '../ext/exts.ts'

/** The extensions provided, as the runs look them up. */
export interface Exts {
  get(contract: string): Ext | undefined
}

/** The extensions as a catalog: each implementation's module is its extension's client's folder, on the host. */
export function catalogOf(exts: Exts): ImplementationCatalog {
  return {
    find(contract, held) {
      const ext = exts.get(contract)
      return ext !== undefined && serves(ext.version, held) ? { contract, version: ext.version, module: ext.client } : undefined
    },
  }
}
