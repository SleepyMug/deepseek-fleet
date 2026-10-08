/**
 * The runtime of a tau's run in its box (tau's docs/spec/library.md), which
 * owns where the run has its things there (./layout.ts). The host has it set
 * the box up from the run's call, which the host checked first: it places
 * the tau, checks the call against it, places the content of the files,
 * expands the args and the prompt with where it placed each, keeps what it needs of the run, puts tau's TAU.md, as the
 * runtime's tau library has it, beside them, and reports to the host what
 * the host needs: the prompt, and where things are. Once the run ended well,
 * the host has it pack the run's result, which the host reads and checks
 * again, since by then the box is the agent's. Each runs as ./main.ts, with
 * `docker exec`, before the agent does, and runs no code of the tau's.
 * @module @sleepymug/fleet-box-runtime/tau/endpoint
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { loadTau, type CheckedCall, type Json } from '@sleepymug/tau'
import { packResult, placeCall, readCall, type Result } from '@sleepymug/tau/call'
import { CLIENTS, FOLDERS, MODULES, PRIMER, RUN, SELF, placer } from './layout.ts'

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
  /** The folder for the clients of the APIs, each in a folder by the API's name. */
  clients: string
  /** The tau's init, its command, its placeholders expanded; none for a tau without one. */
  init?: string
}

/** What the runtime keeps of a run in its box: each file, where the box has each, and the args, expanded. */
interface Kept {
  files: CheckedCall['files']
  places: { [name: string]: string }
  args: { [name: string]: Json }
}

/**
 * Set a box up for a run of a call: make its folders, place the tau the
 * call carries, check the call, place the content of each file, make each
 * `out` file's folder for a directory, and put TAU.md there.
 * @param root - where the box's paths are, the box's root unless a test has them elsewhere.
 */
export async function setup(call: AsyncIterable<Uint8Array>, root = '/'): Promise<Setup> {
  const at = (path: string): string => join(root, path)
  // Kept, to be read twice: for the tau, then, once the call is checked, for the files.
  const scratch = await mkdtemp(join(tmpdir(), 'fleet-call-'))
  try {
    const file = join(scratch, 'call.tar')
    await pipeline(Readable.from(call), createWriteStream(file))
    const read = await readCall(createReadStream(file))
    if (read.json.tau === undefined) throw new Error('the call does not carry its tau')
    for (const folder of [...Object.values(FOLDERS), CLIENTS]) await mkdir(at(folder), { recursive: true })
    await placeCall(read, { tau: at(SELF) })
    const tau = loadTau(at(SELF))
    const checked = tau.check(read.json)
    const place = placer()
    const places = Object.fromEntries(Object.entries(checked.files).map(([name, file]) => [name, place(file)]))
    const run = tau.expand(checked, places, SELF)
    await placeCall(await readCall(createReadStream(file)), { places: rooted(places, at) })
    for (const [name, { mode, kind }] of Object.entries(checked.files)) if (mode === 'out' && kind === 'dir') await mkdir(at(places[name]), { recursive: true })
    const kept: Kept = { files: { ...checked.files }, places, args: { ...run.args } }
    await writeFile(at(RUN), `${JSON.stringify(kept)}\n`)
    await copyFile(fileURLToPath(import.meta.resolve('@sleepymug/tau/TAU.md')), at(PRIMER))
    return {
      prompt: run.prompt, cwd: FOLDERS.inout, modules: MODULES, self: SELF, clients: CLIENTS,
      ...run.init === undefined ? {} : { init: run.init },
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * The result's archive of a run that ended as `outcome` says: what the agent
 * left at each `out` and `inout` file's place, checked, or, when it does not
 * fit the tau, a failure.
 * @param root - where the box's paths are, the box's root unless a test has them elsewhere.
 */
export async function pack(outcome: Result, root = '/'): Promise<AsyncIterable<Uint8Array>> {
  const { files, places } = JSON.parse(await readFile(join(root, RUN), 'utf8')) as Kept
  return packResult(outcome, { files }, rooted(places, path => join(root, path)))
}

/** Each place, where `at` has it. */
function rooted(places: { [name: string]: string }, at: (path: string) => string): { [name: string]: string } {
  return Object.fromEntries(Object.entries(places).map(([name, place]) => [name, at(place)]))
}
