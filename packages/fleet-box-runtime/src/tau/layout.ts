/**
 * Where a run of a tau has its things in its box, which the box's runtime
 * (./endpoint.ts) owns, and reports to the host: each `in` file in
 * /tau/in, each `inout` file in /tau/workspace, the working directory, and
 * each `out` file in /tau/out, under the base name its place keeps, and the
 * tau's own directory at /tau/self. A base name already taken in its folder
 * gets a suffix in its stem: notes.md, notes-1.md, notes-2.md. The tau's APIs, and what it exposes, are in
 * /tau/node_modules, so code anywhere below /tau finds them, and the clients
 * that implement the APIs in a hidden folder there. The agent runs its
 * programs from the tau's own directory, `cd /tau/self; node -`, so that
 * they resolve as the tau's own code does: its node_modules first, then
 * /tau/node_modules. What the runtime keeps
 * of the run is in /tau/.run.json, and tau's TAU.md, what a tau is, for the
 * agent to read, in /tau/TAU.md.
 * @module fleet-box-runtime/tau/layout
 */

import { extname, posix } from 'node:path'
import type { CallFile, Mode } from '@sleepymug/tau'

/** The folder for the files of each mode. */
export const FOLDERS: { readonly [M in Mode]: string } = { in: '/tau/in', inout: '/tau/workspace', out: '/tau/out' }

/** The tau's own directory, which `${self}` names. */
export const SELF = '/tau/self'

/** Where the tau's code finds its APIs, and the packages of its own it exposes. */
export const MODULES = '/tau/node_modules'

/** Where each API's client is, in a folder by the API's name. */
export const CLIENTS = `${MODULES}/.fleet`

/** What the runtime keeps of a run: its files, where the box has each, and its args as the agent sees them. */
export const RUN = '/tau/.run.json'

/** tau's TAU.md, what a tau is, and what a run of one promises, for the agent to read. */
export const PRIMER = '/tau/TAU.md'

/** Where the box has each file of one run, asked for each in turn. */
export function placer(): (file: CallFile) => string {
  const taken = new Set<string>()
  return ({ mode, base }) => {
    const extension = extname(base)
    const stem = base.slice(0, base.length - extension.length)
    for (let suffix = 0; ; suffix++) {
      const place = posix.join(FOLDERS[mode], suffix === 0 ? base : `${stem}-${String(suffix)}${extension}`)
      if (taken.has(place)) continue
      taken.add(place)
      return place
    }
  }
}
