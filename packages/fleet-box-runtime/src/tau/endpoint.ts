/**
 * The runtime of a tau's run in its box (tau's docs/spec/library.md), which
 * owns where the run has its things there (./layout.ts). The host has it set
 * the box up from the run's call, which the host checked first: it places
 * the tau and the content of the handles, binds the values, which expands
 * the prompt, keeps what it needs of the run, puts tau's TAU.md, as the
 * runtime's tau library has it, beside them, and reports to the host what
 * the host needs: the prompt, and where things are. Once the run ended well,
 * the host has it pack the run's result, which the host reads and checks
 * again, since by then the box is the agent's. Each runs as ./main.ts, with
 * `docker exec`, before the agent does, and runs no code of the tau's.
 * @module fleet-box-runtime/tau/endpoint
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { loadTau, type BoundHandle, type Value } from '@sleepymug/tau'
import { packResult, placeCall, readCall, type Result } from '@sleepymug/tau/call'
import { CLIENTS, FOLDERS, MODULES, PRIMER, RUN, SELF, placer } from './layout.ts'

/** What the host learns of a run from setting up its box: where things are in the box, all absolute. */
export interface Setup {
  /** The tau's prompt, expanded with where the box has each handle. */
  prompt: string
  /** The agent's working directory. */
  cwd: string
  /** The node_modules folder where the tau's code finds its APIs, and what it exposes. */
  modules: string
  /** The tau's own directory. */
  self: string
  /** The folder for the clients of the APIs, each in a folder by the API's name. */
  clients: string
  /** Each handle of the run, with where the box has it. */
  handles: BoundHandle[]
  /** The tau's init, its command, `${self}` expanded; none for a tau without one. */
  init?: string
}

/** What the runtime keeps of a run in its box. */
interface Kept {
  handles: BoundHandle[]
  values: { [name: string]: Value }
}

/**
 * Set a box up for a run of a call: make its folders, place the tau the
 * call carries, bind the call's values, place the content of each handle,
 * make each `$out` handle's folder for a directory, and put TAU.md there.
 * @param root - where the box's paths are, the box's root unless a test has them elsewhere.
 */
export async function setup(call: AsyncIterable<Uint8Array>, root = '/'): Promise<Setup> {
  const at = (path: string): string => join(root, path)
  // Kept, to be read twice: for the tau, then, once the values are bound, for the handles.
  const scratch = await mkdtemp(join(tmpdir(), 'fleet-call-'))
  try {
    const file = join(scratch, 'call.tar')
    await pipeline(Readable.from(call), createWriteStream(file))
    const read = await readCall(createReadStream(file))
    if (read.json.tau === undefined) throw new Error('the call does not carry its tau')
    for (const folder of [...Object.values(FOLDERS), CLIENTS]) await mkdir(at(folder), { recursive: true })
    await placeCall(read, { tau: at(SELF) })
    const run = loadTau(at(SELF)).bind(read.json.values, { cwd: '/' }, placer(), SELF)
    await placeCall(await readCall(createReadStream(file)), { handles: run.handles.map(handle => ({ ...handle, view: at(handle.view) })) })
    for (const handle of run.handles) if (handle.mode === 'out' && handle.kind === 'dir') await mkdir(at(handle.view), { recursive: true })
    const kept: Kept = { handles: [...run.handles], values: { ...run.values } }
    await writeFile(at(RUN), `${JSON.stringify(kept)}\n`)
    await copyFile(fileURLToPath(import.meta.resolve('@sleepymug/tau/TAU.md')), at(PRIMER))
    return {
      prompt: run.prompt, cwd: FOLDERS.inout, modules: MODULES, self: SELF, clients: CLIENTS, handles: kept.handles,
      ...run.init === undefined ? {} : { init: run.init },
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * The result's archive of a run that ended as `outcome` says: what the agent
 * left at each `$out` and `$inout` handle's place, checked, or, when it does
 * not fit the tau, a failure.
 * @param root - where the box's paths are, the box's root unless a test has them elsewhere.
 */
export async function pack(outcome: Result, root = '/'): Promise<AsyncIterable<Uint8Array>> {
  const { handles } = JSON.parse(await readFile(join(root, RUN), 'utf8')) as Kept
  return packResult(outcome, handles, ({ view }) => join(root, view))
}
