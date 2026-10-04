/**
 * Where a run of a tau has its things in its box: each `$in` handle in
 * /tau/in, each `$inout` handle in /tau/workspace, and each `$out` handle in
 * /tau/out, under the base name of the caller's path, and the tau's own
 * directory at /tau/self. A base name already taken in its folder gets a
 * suffix in its stem: notes.md, notes-1.md, notes-2.md.
 * @module fleet-core/tau/place
 */

import { basename, extname, posix } from 'node:path'
import type { Mode, Placing } from '@sleepymug/tau'

/** The folder for the handles of each mode. */
export const FOLDERS: { readonly [M in Mode]: string } = { in: '/tau/in', inout: '/tau/workspace', out: '/tau/out' }

/** The tau's own directory, which `${self}` names. */
export const SELF = '/tau/self'

/** A `place` for one run, as tau's `bind` takes it: where the box has each handle. */
export function placer(): (handle: Placing) => string {
  const taken = new Set<string>()
  return ({ mode, host }) => {
    const name = basename(host)
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
