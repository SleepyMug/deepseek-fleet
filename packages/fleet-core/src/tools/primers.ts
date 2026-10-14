/**
 * tau's primers as dsh skills: TAU.md, what a tau takes and what a run of
 * one promises, and TAU_DEV.md, how to make one, as tau's library has them.
 * Every session that works on the host has them (./tau.ts), and the `tau`
 * preset shadows them (../preset/prompt.ts): a tau's session reads them in
 * its box, where fleet-box-runtime puts them.
 * @module @sleepymug/fleet-core/tools/primers
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface Primer {
  /** The skill's name. */
  name: string
  /** What the skill catalog says of it, for the model to tell when to load it. */
  description: string
  /** The file it is, by its module specifier. */
  specifier: string
}

export const PRIMERS: readonly Primer[] = [
  {
    name: 'tau',
    description: 'What a TAU, an agent packaged as a directory, takes, and what a run of one promises. Load it before you run a TAU with tau_run.',
    specifier: '@sleepymug/tau/TAU.md',
  },
  {
    name: 'tau-dev',
    description: 'How to make a TAU: its directory, tau.json, prompt, APIs, programs, skills and init. Load it before you make or change a TAU.',
    specifier: '@sleepymug/tau/TAU_DEV.md',
  },
]

/** Where a primer is, as tau's library has it. */
export function pathOf({ specifier }: Primer): string {
  return fileURLToPath(import.meta.resolve(specifier))
}

/** What a primer says. */
export function textOf(primer: Primer): string {
  return readFileSync(pathOf(primer), 'utf8')
}
