/**
 * How the host and the box's tau runtime (./endpoint.ts) talk, which both
 * import, so that each command is made, read and answered in one place. The
 * host runs the runtime in a run's box with `docker exec`, since the
 * helper's lines of JSON would carry the archives only as text:
 * `node main.js setup '{"offered"}'`, with the run's call on stdin, which
 * writes its {@link Setup} as JSON to stdout; and `node main.js pack
 * '{"outcome"}'`, which writes the run's result to stdout. Why one fails
 * goes to stderr. The runtime runs before the agent does, on a call the
 * host admitted, so the host takes its report as it is, once it has its
 * shape; the result it packs comes from what the agent left, and the host
 * checks it again.
 * @module @sleepymug/fleet-box-runtime/tau/protocol
 */

import { Writable } from 'node:stream'
import { posix } from 'node:path'
import type { Outcome } from '@sleepymug/tau/core'
import { HELPER_NODE, TAU_ENTRY } from '../layout.ts'

/** A contract the host has a client of, at the version the client implements. */
export interface Offered {
  contract: string
  version: string
}

/** What the host learns of a run from setting up its box: where things are in the box, all absolute. */
export interface Setup {
  /** The tau's prompt, expanded with where the box has each file. */
  prompt: string
  /** The agent's working directory. */
  cwd: string
  /** Where each file is, by name, extra files included. */
  places: { [name: string]: string }
  /** The node_modules folder where the tau's code finds its APIs, and what it exposes. */
  modules: string
  /** The tau's own directory. */
  self: string
  /** The tau's init, its command, its placeholders expanded; none for a tau without one. */
  init?: string
  /** Each API of the tau, by its contract's name: where its client goes, and where its contract's declarations go. */
  links: { contract: string; client: string; declarations: string }[]
  /** The packages of the tau's own that it exposes, each by name, with its folder. */
  packages: { name: string; dir: string }[]
}

/** A command of the runtime's. */
export type TauCommand =
  | { command: 'setup'; offered: Offered[] }
  | { command: 'pack'; outcome: Outcome }

/** What runs a program in a started box, `input` its stdin, and its stdout written to `output`, as the host's `Box.pipe` does. */
export type Pipe = (argv: string[], io: { input?: AsyncIterable<Uint8Array>; output?: Writable }) => Promise<void>

/** The command line the host runs a command with in the box. */
export function tauArgv(command: TauCommand): string[] {
  const { command: name, ...json } = command
  return [HELPER_NODE, TAU_ENTRY, name, JSON.stringify(json)]
}

/**
 * A command, as its command line has it after the program: its name, and
 * its JSON, which only the host writes, as {@link tauArgv} does.
 */
export function readTauCommand(args: readonly string[]): TauCommand {
  const [name, json] = args
  if (name === 'setup') return { command: 'setup', offered: (JSON.parse(json ?? '') as { offered: Offered[] }).offered }
  if (name === 'pack') return { command: 'pack', outcome: (JSON.parse(json ?? '') as { outcome: Outcome }).outcome }
  throw new TypeError(`no command ${String(name)}; setup or pack`)
}

/**
 * Have a started box's runtime set the box up from a run's call, offered
 * the contracts the host has clients of.
 * @returns its report, once it has the shape of one.
 */
export async function requestSetup(pipe: Pipe, call: AsyncIterable<Uint8Array>, offered: Offered[]): Promise<Setup> {
  const output = new Collected()
  await pipe(tauArgv({ command: 'setup', offered }), { input: call, output })
  return readSetup(output.text())
}

/** Have a started box's runtime pack the result of its run, which ended as `outcome` says, to `output`. */
export async function requestPack(pipe: Pipe, outcome: Outcome, output: Writable): Promise<void> {
  await pipe(tauArgv({ command: 'pack', outcome }), { output })
}

/** A setup's report, as the runtime writes it, checked for its shape. */
export function readSetup(text: string): Setup {
  let setup: Partial<Setup>
  try {
    setup = JSON.parse(text) as Partial<Setup>
  } catch {
    throw new Error(`fleet: the box's runtime reported something else than JSON: ${text.slice(0, 200)}`)
  }
  const absolute = (path: unknown): boolean => typeof path === 'string' && posix.isAbsolute(path)
  const paths = [setup.cwd, setup.modules, setup.self]
  if (typeof setup.prompt !== 'string' || !['string', 'undefined'].includes(typeof setup.init) || !paths.every(absolute)
    || typeof setup.places !== 'object' || setup.places === null || Array.isArray(setup.places) || !Object.values(setup.places).every(absolute)
    || !Array.isArray(setup.links) || !setup.links.every(link => typeof link?.contract === 'string' && absolute(link.client) && absolute(link.declarations))
    || !Array.isArray(setup.packages) || !setup.packages.every(entry => typeof entry?.name === 'string' && absolute(entry.dir))) {
    throw new Error('fleet: the box\'s runtime reported no setup')
  }
  return setup as Setup
}

/** What is written to it, kept. */
class Collected extends Writable {
  private readonly chunks: Buffer[] = []

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.chunks.push(chunk)
    done()
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}
