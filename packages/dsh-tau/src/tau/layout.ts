/**
 * Where a run of a tau has its things in its box, which dsh-tau lays out
 * (./placement.ts): each `in` file
 * in /tau/in, each `inout` file in /tau/workspace, the working directory,
 * and each `out` file in /tau/out, under the base name its place keeps, as
 * tau's backend SDK asks, and the tau's own directory at /tau/self. A file
 * whose base name is taken in its folder is in a folder of its own there,
 * named for the file, with a suffix if that is taken too: notes.md, then
 * extra/notes.md, for the file extra. /tau/node_modules links the clients
 * of the box's services, which fleet's gateway puts in
 * /fleet/node_modules/@fleet, so that a program anywhere below /tau imports
 * them. The run's context is /tau/context.json, which `TAU_CONTEXT`
 * names for every process in the box (tau's docs/spec/context.md); and
 * tau's TAU.md, what a tau is, and TAU_DEV.md, how to make one, for the
 * agent to read, in /tau.
 * @module @sleepymug/dsh-tau/tau/layout
 */

import { posix } from 'node:path'
import type { CallFile, Mode } from '@sleepymug/tau/core'

/** The folder for the files of each mode. */
export const FOLDERS: { readonly [M in Mode]: string } = { in: '/tau/in', inout: '/tau/workspace', out: '/tau/out' }

/** The tau's own directory, which `${self}` names. */
export const SELF = '/tau/self'

/** Below which a program imports the clients of the box's services. */
export const PROGRAMS = '/tau'

/** Where the clients of the box's services are, for the programs below {@link PROGRAMS}. */
export const MODULES = `${PROGRAMS}/node_modules`

/** The run's context (tau's docs/spec/context.md). */
export const CONTEXT = '/tau/context.json'

/** Names {@link CONTEXT} for every process in the box. */
export const CONTEXT_VARIABLE = 'TAU_CONTEXT'

/** tau's TAU.md, what a tau is, and what a run of one promises, for the agent to read. */
export const PRIMER = '/tau/TAU.md'

/** tau's TAU_DEV.md, how to make a tau, for the agent to read. */
export const DEV_PRIMER = '/tau/TAU_DEV.md'

/** Where the clients of the box's services are linked, in {@link MODULES}, and where the link leads. */
export const CLIENTS = { link: `${MODULES}/@fleet`, to: '/fleet/node_modules/@fleet' } as const

/** Where each file of one run is in its box, by its name, asked for each in turn. */
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
