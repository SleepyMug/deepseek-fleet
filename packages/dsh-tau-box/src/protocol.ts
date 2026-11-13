/**
 * How dsh-tau and its half in a box (./box/endpoint.ts) talk, which both
 * import, so that each command is made, read and answered in one place.
 * dsh-tau runs the half in a run's box with the `box.pipe` of fleet's gateway,
 * since the helper's lines of JSON would carry the archives only as text:
 * `node main.js setup`, with the run's call on stdin, which writes its
 * {@link Setup} as JSON to stdout; and `node main.js pack '{"outcome"}'`,
 * which writes the run's result to stdout. Why one fails goes to stderr. The
 * half runs before the agent does, on a call dsh-tau admitted, so dsh-tau
 * takes its report as it is, once it has its shape; the result it packs
 * comes from what the agent left, and dsh-tau checks it again.
 * @module @sleepymug/dsh-tau-box/protocol
 */

import { posix } from 'node:path'
import { HELPER_NODE, serviceDir } from '@sleepymug/fleet-protocol/layout'
import type { Outcome } from '@sleepymug/tau/core'
import { SERVICE } from './layout.ts'

/** What dsh-tau learns of a run from setting up its box: where things are in the box, all absolute. */
export interface Setup {
  /** The tau's prompt, expanded with where the box has each file. */
  prompt: string
  /** The agent's working directory. */
  cwd: string
  /** Where each file is, by name, extra files included. */
  places: { [name: string]: string }
  /** The tau's own directory. */
  self: string
  /** The program directory, below which a program imports the tau's packages. */
  programs: string
  /** The tau's init, its command, its placeholders expanded; none for a tau without one. */
  init?: string
  /** The packages of the tau's own that it exposes, each by name, with where it is, and what it says it is. */
  packages: { name: string; dir: string; description?: string }[]
}

/** A command of the half's. */
export type TauCommand =
  | { command: 'setup' }
  | { command: 'pack'; outcome: Outcome }

/**
 * What runs a program in a started box, without a shell: `input`, a host
 * file, its stdin, and its stdout written to `output`, a host file, or else
 * given back, as the gateway's `box.pipe` does.
 */
export type Pipe = (argv: string[], io: { input?: string; output?: string }) => Promise<string>

/** The half's entry in a box, where the gateway puts the tau service's package. */
export const BOX_ENTRY = posix.join(serviceDir(SERVICE), 'lib', 'box', 'main.js')

/** The command line dsh-tau runs a command with in the box. */
export function tauArgv(command: TauCommand): string[] {
  const { command: name, ...json } = command
  return [HELPER_NODE, BOX_ENTRY, name, JSON.stringify(json)]
}

/**
 * A command, as its command line has it after the program: its name, and
 * its JSON, which only dsh-tau writes, as {@link tauArgv} does.
 */
export function readTauCommand(args: readonly string[]): TauCommand {
  const [name, json] = args
  if (name === 'setup') return { command: 'setup' }
  if (name === 'pack') return { command: 'pack', outcome: (JSON.parse(json ?? '') as { outcome: Outcome }).outcome }
  throw new TypeError(`no command ${String(name)}; setup or pack`)
}

/**
 * Have a started box's half set the box up from a run's call, the host
 * file `call`.
 * @returns its report, once it has the shape of one.
 */
export async function requestSetup(pipe: Pipe, call: string): Promise<Setup> {
  return readSetup(await pipe(tauArgv({ command: 'setup' }), { input: call }))
}

/** Have a started box's half pack the result of its run, which ended as `outcome` says, to `output`, a host file. */
export async function requestPack(pipe: Pipe, outcome: Outcome, output: string): Promise<void> {
  await pipe(tauArgv({ command: 'pack', outcome }), { output })
}

/** A setup's report, as the half writes it, checked for its shape. */
export function readSetup(text: string): Setup {
  let setup: Partial<Setup>
  try {
    setup = JSON.parse(text) as Partial<Setup>
  } catch {
    throw new Error(`dsh-tau: the box's half reported something else than JSON: ${text.slice(0, 200)}`)
  }
  const absolute = (path: unknown): boolean => typeof path === 'string' && posix.isAbsolute(path)
  if (typeof setup.prompt !== 'string' || !['string', 'undefined'].includes(typeof setup.init) || ![setup.cwd, setup.self, setup.programs].every(absolute)
    || typeof setup.places !== 'object' || setup.places === null || Array.isArray(setup.places) || !Object.values(setup.places).every(absolute)
    || !Array.isArray(setup.packages)
    || !setup.packages.every(entry => typeof entry?.name === 'string' && absolute(entry.dir) && ['string', 'undefined'].includes(typeof entry.description))) {
    throw new Error('dsh-tau: the box\'s half reported no setup')
  }
  return setup as Setup
}
