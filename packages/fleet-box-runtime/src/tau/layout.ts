/**
 * Where a run of a tau has its things in its box, which the box's runtime
 * (./endpoint.ts) owns, and reports to the host: each `$in` handle in
 * /tau/in, each `$inout` handle in /tau/workspace, the working directory,
 * and each `$out` handle in /tau/out, under its name, the base name of the
 * caller's path, and the tau's own directory at /tau/self. A base name
 * already taken in its folder gets a suffix in its stem: notes.md,
 * notes-1.md, notes-2.md. The tau's APIs, and what it exposes, are in
 * /tau/node_modules, so code anywhere below /tau finds them, and the clients
 * that implement the APIs in a hidden folder there. What the runtime keeps
 * of the run is in /tau/.run.json.
 * @module fleet-box-runtime/tau/layout
 */

import { extname, posix } from 'node:path'
import type { Mode, Placing } from '@sleepymug/tau'

/** The folder for the handles of each mode. */
export const FOLDERS: { readonly [M in Mode]: string } = { in: '/tau/in', inout: '/tau/workspace', out: '/tau/out' }

/** The tau's own directory, which `${self}` names. */
export const SELF = '/tau/self'

/** Where the tau's code finds its APIs, and the packages of its own it exposes. */
export const MODULES = '/tau/node_modules'

/** Where each API's client is, in a folder by the API's name. */
export const CLIENTS = `${MODULES}/.fleet`

/** What the runtime keeps of a run: its handles, and its values as the agent sees them. */
export const RUN = '/tau/.run.json'

/** A `place` for one run, as tau's `bind` takes it: where the box has each handle. */
export function placer(): (handle: Placing) => string {
  const taken = new Set<string>()
  return ({ mode, name }) => {
    const extension = extname(name)
    const stem = name.slice(0, name.length - extension.length)
    for (let suffix = 0; ; suffix++) {
      const place = posix.join(FOLDERS[mode], suffix === 0 ? name : `${stem}-${String(suffix)}${extension}`)
      if (taken.has(place)) continue
      taken.add(place)
      return place
    }
  }
}
