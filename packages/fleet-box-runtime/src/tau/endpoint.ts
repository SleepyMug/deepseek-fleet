/**
 * The box's half of the backend of a tau's run (tau's docs/spec/backend.md),
 * which owns where the run has its things there (./layout.ts). The host has
 * it set the box up from the run's call, which the host admitted first:
 * with tau's backend SDK, it places the tau, admits the call against it,
 * linking each API to the client of a contract the host offers, places the
 * content of the files, checks them, expands the args and the prompt with
 * where it placed each, keeps what it needs of the run, puts tau's TAU.md,
 * as the runtime's tau library has it, beside them, and reports to the host
 * what the host needs: the prompt, where things are, and which client each
 * API needs. Once the run ended, the host has it pack the run's result,
 * which the host reads and checks again, since by then the box is the
 * agent's. Each runs as ./main.ts, with `docker exec`, before the agent
 * does, and runs no code of the tau's.
 * @module @sleepymug/fleet-box-runtime/tau/endpoint
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Admitted, catalogOf, createBackendSdk } from '@sleepymug/tau/backend'
import { checkOutputs, type Envelope, type Json, kindAt, type Outcome, type Output } from '@sleepymug/tau/core'
import { packResult, unpackCall } from '@sleepymug/tau/wire-tar'
import { FOLDERS, MODULES, PRIMER, RUN, SELF, clientOf, placer } from './layout.ts'

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
  /** The node_modules folder where the tau's code finds its APIs, and what it exposes. */
  modules: string
  /** The tau's own directory. */
  self: string
  /** The tau's init, its command, its placeholders expanded; none for a tau without one. */
  init?: string
  /** Each API of the tau, by its alias: its contract, and where its client goes. */
  links: { alias: string; contract: string; client: string }[]
  /** The packages of the tau's own that it exposes, each by name, with its folder. */
  packages: { name: string; dir: string }[]
}

/** What the runtime keeps of a run in its box: each file, where the box has each, and the args, expanded. */
interface Kept {
  files: Envelope['files']
  places: { [name: string]: string }
  args: { [name: string]: Json }
}

/**
 * Set a box up for a run of a call: make its folders, place the tau the
 * call carries, admit the call, place the content of each file, make each
 * `out` file's folder for a directory, and the folder each API's client
 * goes in, and put TAU.md there.
 * @param offered - the contracts whose clients the host has, for the tau's APIs.
 * @param root - where the box's paths are, the box's root unless a test has them elsewhere.
 */
export async function setup(call: AsyncIterable<Uint8Array>, offered: readonly Offered[], root = '/'): Promise<Setup> {
  const at = (path: string): string => join(root, path)
  for (const folder of Object.values(FOLDERS)) await mkdir(at(folder), { recursive: true })
  const sdk = createBackendSdk({ implementations: catalogOf(offered.map(({ contract, version }) => ({ contract, version, module: clientOf(contract) }))) })
  let admitted: Admitted | undefined
  const places: { [name: string]: string } = {}
  await unpackCall(call, {
    tau: at(SELF),
    place(envelope) {
      admitted = sdk.admit(envelope, at(SELF))
      const place = placer()
      for (const [name, file] of Object.entries(admitted.envelope.files)) places[name] = place(name, file)
      return rooted(places, at)
    },
  })
  const { tau, envelope, links } = admitted as Admitted
  ;(admitted as Admitted).place(rooted(places, at))
  const run = tau.expand(envelope, places, SELF)
  for (const [name, { mode, kind }] of Object.entries(envelope.files)) if (mode === 'out' && kind === 'dir') await mkdir(at(places[name]), { recursive: true })
  // The folder each client goes in, as a scoped contract's name has one, which the host's copy does not make.
  for (const { implementation } of links) await mkdir(at(posix.dirname(implementation.module)), { recursive: true })
  const kept: Kept = { files: { ...envelope.files }, places, args: { ...run.args } }
  await writeFile(at(RUN), `${JSON.stringify(kept)}\n`)
  await copyFile(fileURLToPath(import.meta.resolve('@sleepymug/tau/TAU.md')), at(PRIMER))
  return {
    prompt: run.prompt,
    cwd: FOLDERS.inout,
    modules: MODULES,
    self: SELF,
    ...run.init === undefined ? {} : { init: run.init },
    links: links.map(({ api, implementation }) => ({ alias: api.alias, contract: implementation.contract, client: implementation.module })),
    packages: tau.exposed.flatMap(entry => entry.kind === 'package' ? [{ name: entry.specifier, dir: posix.join(SELF, ...relative(tau.dir, entry.dir).split(sep)) }] : []),
  }
}

/**
 * The result's archive of a run that ended as `outcome` says, as tau's
 * backend SDK collects it: if it succeeded, what the agent left at each
 * `out` and `inout` file's place, checked; if that does not fit, or the run
 * failed, a run that failed, giving back nothing.
 * @param root - where the box's paths are, the box's root unless a test has them elsewhere.
 */
export async function pack(outcome: Outcome, root = '/'): Promise<AsyncIterable<Uint8Array>> {
  const { files, places } = JSON.parse(await readFile(join(root, RUN), 'utf8')) as Kept
  const at = rooted(places, path => join(root, path))
  let result: Outcome = outcome.ok ? { ok: true, text: outcome.text } : outcome
  if (result.ok) {
    try {
      checkOutputs({ files }, at)
    } catch (error) {
      result = { ok: false, text: result.text, failure: error instanceof Error ? error.message : String(error) }
    }
  }
  const outputs: { [name: string]: Output } = {}
  const sources: { [name: string]: string } = {}
  if (result.ok) {
    for (const [name, { mode }] of Object.entries(files)) {
      if (mode === 'in') continue
      sources[name] = at[name]
      outputs[name] = { kind: kindAt(sources[name]) }
    }
  }
  return packResult({ ...result, outputs }, sources)
}

/** Each place, where `at` has it. */
function rooted(places: { [name: string]: string }, at: (path: string) => string): { [name: string]: string } {
  return Object.fromEntries(Object.entries(places).map(([name, place]) => [name, at(place)]))
}
