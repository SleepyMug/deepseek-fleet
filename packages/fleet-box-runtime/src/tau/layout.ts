/**
 * Where a run of a tau has its things in its box, which the box's runtime
 * (./endpoint.ts) owns, and reports to the host: each `in` file in
 * /tau/in, each `inout` file in /tau/workspace, the working directory, and
 * each `out` file in /tau/out, under the base name its place keeps, as tau's
 * backend SDK asks, and the tau's own directory at /tau/self. A file whose
 * base name is taken in its folder is in a folder of its own there, named
 * for the file, with a suffix if that is taken too: notes.md, then
 * extra/notes.md, for the file extra. The tau's APIs, and what it exposes,
 * are in /tau/node_modules, so code anywhere below /tau finds them, each
 * API by its contract's name; the clients that implement the APIs in a
 * hidden folder there, and the contracts' declarations, as the extensions
 * have them, in another, each in a folder by its contract's name. The agent runs its
 * programs from the tau's own directory, `cd /tau/self; node -`, so that
 * they resolve as the tau's own code does: its node_modules first, then
 * /tau/node_modules. What the runtime keeps
 * of the run is in /tau/.run.json; and tau's TAU.md, what a tau is, and
 * TAU_DEV.md, how to make one, for the agent to read, in /tau.
 * @module @sleepymug/fleet-box-runtime/tau/layout
 */

import { posix } from 'node:path'
import type { CallFile, Mode } from '@sleepymug/tau/core'

/** The folder for the files of each mode. */
export const FOLDERS: { readonly [M in Mode]: string } = { in: '/tau/in', inout: '/tau/workspace', out: '/tau/out' }

/** The tau's own directory, which `${self}` names. */
export const SELF = '/tau/self'

/** Where the tau's code finds its APIs, and the packages of its own it exposes. */
export const MODULES = '/tau/node_modules'

/** Where each API's client is, in a folder by its contract's name. */
export const CLIENTS = `${MODULES}/.fleet`

/** Where the client that implements a contract is. */
export function clientOf(contract: string): string {
  return posix.join(CLIENTS, contract)
}

/** Where each API's contract is, its package.json and declarations, in a folder by its name. */
export const CONTRACTS = `${MODULES}/.contracts`

/** Where the declarations of a contract are, as its extension has them. */
export function contractOf(contract: string): string {
  return posix.join(CONTRACTS, contract)
}

/** What the runtime keeps of a run: its files, where the box has each, and its args as the agent sees them. */
export const RUN = '/tau/.run.json'

/** tau's TAU.md, what a tau is, and what a run of one promises, for the agent to read. */
export const PRIMER = '/tau/TAU.md'

/** tau's TAU_DEV.md, how to make a tau, for the agent to read. */
export const DEV_PRIMER = '/tau/TAU_DEV.md'

/** Where the box has each file of one run, by its name, asked for each in turn. */
export function placer(): (name: string, file: Pick<CallFile, 'mode' | 'base'>) => string {
  // What each folder holds, by name.
  const taken = new Set<string>()
  const take = (mode: Mode, name: string): boolean => {
    const place = posix.join(FOLDERS[mode], name)
    if (taken.has(place)) return false
    taken.add(place)
    return true
  }
  return (name, { mode, base }) => {
    if (take(mode, base)) return posix.join(FOLDERS[mode], base)
    for (let suffix = 0; ; suffix++) {
      const folder = suffix === 0 ? name : `${name}-${String(suffix)}`
      if (take(mode, folder)) return posix.join(FOLDERS[mode], folder, base)
    }
  }
}
