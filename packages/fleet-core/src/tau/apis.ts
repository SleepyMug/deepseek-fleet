/**
 * The APIs of a run of a tau (tau's docs/spec/implementations.md): each API
 * the tau declares is linked to the client of the extension that implements
 * it (../ext/), and a tau with an API no extension implements, or whose
 * client does not fit it, is refused before anything is made. What the tau
 * exposes, of its APIs and of its own packages, is what its programs import.
 * @module fleet-core/tau/apis
 */

import { join } from 'node:path'
import { checkImplementation, loadApis, loadExposed, type Tau } from '@sleepymug/tau'
import type { Ext } from '../ext/exts.ts'

/** The extensions provided, as the runs look them up. */
export interface Exts {
  get(api: string): Ext | undefined
}

export interface Linked {
  /** Each API the tau declares, with the folder of its extension's client on the host. */
  apis: { name: string; client: string }[]
  /** What the tau exposes, by what programs import: `@api/<name>`, or a package's name. */
  exposed: string[]
  /** The packages of the tau's own that it exposes, each by name, with its folder in the tau. */
  packages: { name: string; dir: string }[]
}

/**
 * Link the tau's APIs to the extensions provided.
 * @throws listing each API no extension implements, or whose client does not fit it, and what breaks the spec.
 */
export function linkApis(tau: Tau, exts: Exts): Linked {
  const apis = loadApis(tau.dir)
  const problems: string[] = []
  const linked: Linked['apis'] = []
  for (const api of apis) {
    const ext = exts.get(api.name)
    if (ext === undefined) {
      problems.push(`${api.specifier}: no extension implements it`)
      continue
    }
    try {
      checkImplementation(api, join(ext.client, 'index.js'))
      linked.push({ name: api.name, client: ext.client })
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (problems.length > 0) throw new Error(`fleet: ${tau.dir} cannot run here:\n  ${problems.join('\n  ')}`)
  const exposed = loadExposed(tau, apis)
  return {
    apis: linked,
    exposed: exposed.map(entry => entry.specifier),
    packages: exposed.flatMap(entry => entry.kind === 'package' ? [{ name: entry.specifier, dir: entry.dir }] : []),
  }
}
