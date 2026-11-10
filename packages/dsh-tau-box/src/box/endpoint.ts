/**
 * dsh-tau's half of a run's backend in its box (tau's docs/spec/backend.md),
 * which owns where the run has its things there (../layout.ts). dsh-tau has
 * it set the box up from the run's call, which dsh-tau admitted first: with
 * tau's backend SDK, it places the tau, admits the call against it, places
 * the content of the files, checks them, expands the args and the prompt
 * with where it placed each, writes the run's context, links the tau's
 * packages below the program directory, puts tau's TAU.md and TAU_DEV.md
 * beside them, and reports what dsh-tau needs: the prompt, and where things
 * are. Once the run ended, dsh-tau has it pack the run's result, which
 * dsh-tau reads and checks again, since by then the box is the agent's.
 * Each runs as ./main.ts, through the fleet host's `box.pipe`, before the
 * agent does, and runs no code of the tau's, as ../protocol.ts has the
 * commands.
 * @module @sleepymug/dsh-tau-box/box/endpoint
 */

import { copyFile, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Admitted, createBackendSdk } from '@sleepymug/tau/backend'
import { checkOutputs, type Envelope, kindAt, type Outcome, type Output } from '@sleepymug/tau/core'
import { packResult, unpackCall } from '@sleepymug/tau/wire-tar'
import { CONTEXT, DEV_PRIMER, FOLDERS, MODULES, PRIMER, PROGRAMS, RUN, SELF, placer } from '../layout.ts'
import type { Setup } from '../protocol.ts'

/** What dsh-tau keeps of a run in its box beside its context: each file as the call has it, and where the box has it. */
interface Kept {
  files: Envelope['files']
  places: { [name: string]: string }
}

/**
 * Set a box up for a run of a call: make its folders, place the tau the
 * call carries, admit the call, place the content of each file, make each
 * `out` file's folder for a directory, write the run's context, link the
 * tau's packages, and put TAU.md and TAU_DEV.md there.
 * @param root - where the box's paths are, the box's root unless a test has them elsewhere.
 */
export async function setup(call: AsyncIterable<Uint8Array>, root = '/'): Promise<Setup> {
  const at = (path: string): string => join(root, path)
  for (const folder of Object.values(FOLDERS)) await mkdir(at(folder), { recursive: true })
  const sdk = createBackendSdk()
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
  const { tau, envelope } = admitted as Admitted
  ;(admitted as Admitted).place(rooted(places, at))
  const run = tau.expand(envelope, places, SELF)
  for (const [name, { mode, kind }] of Object.entries(envelope.files)) if (mode === 'out' && kind === 'dir') await mkdir(at(places[name] as string), { recursive: true })
  const kept: Kept = { files: { ...envelope.files }, places }
  await writeFile(at(RUN), `${JSON.stringify(kept)}\n`)
  await writeFile(at(CONTEXT), `${JSON.stringify({ self: SELF, files: places, args: run.args }, null, 2)}\n`)
  // The tau's packages, below the program directory: a link, so the tau's directory holds the only copy.
  await rm(at(MODULES), { recursive: true, force: true })
  if (await isDir(join(tau.dir, 'node_modules'))) await symlink(posix.relative(PROGRAMS, posix.join(SELF, 'node_modules')), at(MODULES))
  await copyFile(fileURLToPath(import.meta.resolve('@sleepymug/tau/TAU.md')), at(PRIMER))
  await copyFile(fileURLToPath(import.meta.resolve('@sleepymug/tau/TAU_DEV.md')), at(DEV_PRIMER))
  return {
    prompt: run.prompt,
    cwd: FOLDERS.inout,
    places,
    self: SELF,
    programs: PROGRAMS,
    ...run.init === undefined ? {} : { init: run.init },
    packages: tau.exposed.map(({ specifier, description, dir }) => ({
      name: specifier,
      dir: posix.join(MODULES, ...relative(join(tau.dir, 'node_modules'), dir).split(sep)),
      ...description === undefined ? {} : { description },
    })),
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
      sources[name] = at[name] as string
      outputs[name] = { kind: kindAt(sources[name]) }
    }
  }
  return packResult({ ...result, outputs }, sources)
}

/** Each place, where `at` has it. */
function rooted(places: { [name: string]: string }, at: (path: string) => string): { [name: string]: string } {
  return Object.fromEntries(Object.entries(places).map(([name, place]) => [name, at(place)]))
}

function isDir(path: string): Promise<boolean> {
  return stat(path).then(info => info.isDirectory(), () => false)
}
