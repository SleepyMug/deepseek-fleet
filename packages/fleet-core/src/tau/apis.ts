/**
 * The APIs of a run of a tau (tau's docs/spec/implementations.md): each API
 * the tau holds, a copy of a contract, is linked to the client of the
 * extension that implements the contract, at a version that serves the
 * copy's, and a tau with an API no extension serves is refused before
 * anything is made. What the tau exposes, of its APIs and of its own
 * packages, is what its programs import.
 * @module @sleepymug/fleet-core/tau/apis
 */

import { serves, type Tau } from '@sleepymug/tau'
import type { Ext } from '../ext/exts.ts'

/** The extensions provided, as the runs look them up. */
export interface Exts {
  get(contract: string): Ext | undefined
}

export interface Linked {
  /** Each API the tau holds: its alias, its contract, and the folder of its extension's client on the host. */
  apis: { alias: string; contract: string; client: string }[]
  /** What the tau exposes, by what programs import: `@api/<alias>`, or a package's name; and what it says it is. */
  exposed: { specifier: string; description?: string }[]
  /** The packages of the tau's own that it exposes, each by name, with its folder in the tau. */
  packages: { name: string; dir: string }[]
}

/**
 * Link the tau's APIs to the extensions provided.
 * @throws listing each API whose contract no extension implements, or at no version that serves the tau's copy.
 */
export function linkApis(tau: Tau, exts: Exts): Linked {
  const problems: string[] = []
  const linked: Linked['apis'] = []
  for (const api of tau.apis) {
    const ext = exts.get(api.contract)
    if (ext === undefined) problems.push(`${api.specifier}: no extension implements ${api.contract}`)
    else if (!serves(ext.version, api.version)) problems.push(`${api.specifier}: the extension of ${api.contract} implements ${ext.version}, which does not serve the tau's ${api.version}`)
    else linked.push({ alias: api.alias, contract: api.contract, client: ext.client })
  }
  if (problems.length > 0) throw new Error(`fleet: ${tau.dir} cannot run here:\n  ${problems.join('\n  ')}`)
  return {
    apis: linked,
    exposed: tau.exposed.map(({ specifier, description }) => ({ specifier, ...description === undefined ? {} : { description } })),
    packages: tau.exposed.flatMap(entry => entry.kind === 'package' ? [{ name: entry.specifier, dir: entry.dir }] : []),
  }
}
