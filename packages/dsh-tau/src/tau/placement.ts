/**
 * A run's box, as dsh-tau lays it out from the run's call (./layout.ts),
 * and the run's result, as it packs it from what the agent left there,
 * both here, on the host: the box is the agent's, so nothing of the run's
 * backend runs in it. The run's things are placed in a folder here as the
 * box will have them, with tau's backend SDK, and put in the box as one
 * tree; once the run ended, what the agent left at the places of its `out`
 * and `inout` files is got back from the box into a folder here, and
 * packed and checked as tau's backend SDK collects a result.
 * @module @sleepymug/dsh-tau/tau/placement
 */

import { copyFile, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { Code, ConnectError } from '@connectrpc/connect'
import { type Admitted, createBackendSdk } from '@sleepymug/tau/backend'
import { checkOutputs, checkReport, type Envelope, kindAt, type Outcome, type Output } from '@sleepymug/tau/core'
import { decodeResult, packResult, unpackCall } from '@sleepymug/tau/wire-tar'
import { packTree, unpackTree } from '@sleepymug/fleet-pack'
import { FileType } from '@sleepymug/fleet-protocol/box'
import { messageOf } from '../util/error.ts'
import { CLIENTS, CONTEXT, DEV_PRIMER, FOLDERS, MODULES, PRIMER, PROGRAMS, SELF, placer } from './layout.ts'
import type { Accepted } from './admission.ts'
import type { FleetBoxPort } from './ports.ts'
import type { Entry } from './registry.ts'

/** What dsh-tau learns of a run from laying out its box: where things are in the box, all absolute. */
export interface Setup {
  /** The tau's prompt, expanded with where the box has each file. */
  prompt: string
  /** The agent's working directory. */
  cwd: string
  /** Where each file is, by name, extra files included. */
  places: { [name: string]: string }
  /** The program directory, below which a program imports the tau's packages. */
  programs: string
  /** The tau's init, its command, its placeholders expanded; none for a tau without one. */
  init?: string
  /** The packages of the tau's own that it exposes, each by name, with where it is, and what it says it is. */
  packages: { name: string; dir: string; description?: string }[]
}

/**
 * Lay a run's box out from its call: place, in `scratch`, as the box will
 * have them, the tau the call carries, each file's content, each `out`
 * directory's folder, the run's context, the link to the tau's packages,
 * tau's primers, and the link to the clients of the box's services; put
 * them in the box, at its root, as one tree; and remove `scratch`.
 * @param call - the file of the run's call, as it was admitted.
 */
export async function furnish(box: FleetBoxPort, call: string, scratch: string): Promise<Setup> {
  try {
    const setup = await layOut(createReadStream(call), scratch)
    await box.put(packTree(scratch), '/')
    return setup
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Lay a run's box out from its call in `root`, as the box will have it at its root. */
export async function layOut(call: AsyncIterable<Uint8Array>, root: string): Promise<Setup> {
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
  await writeFile(at(CONTEXT), `${JSON.stringify({ self: SELF, files: places, args: run.args }, null, 2)}\n`)
  // The tau's packages, below the program directory: a link, so the tau's directory holds the only copy.
  if (await isDir(join(tau.dir, 'node_modules'))) await symlink(posix.relative(PROGRAMS, posix.join(SELF, 'node_modules')), at(MODULES))
  await copyFile(fileURLToPath(import.meta.resolve('@sleepymug/tau/TAU.md')), at(PRIMER))
  await copyFile(fileURLToPath(import.meta.resolve('@sleepymug/tau/TAU_DEV.md')), at(DEV_PRIMER))
  await mkdir(at(posix.dirname(CLIENTS.link)), { recursive: true })
  await symlink(CLIENTS.to, at(CLIENTS.link))
  return {
    prompt: run.prompt,
    cwd: FOLDERS.inout,
    places,
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
 * Keep the result of a run, which ended as `outcome` says, in `file`: for a
 * run that succeeded, what the agent left at the place of each `out` and
 * `inout` file, got back from the box into `scratch`, checked as tau's
 * backend SDK checks it, failing the run when it does not fit the run's
 * files, or the box cannot give it; a run that failed gives back nothing.
 * @param box - gives the run's box, asked for only when a run succeeded.
 * @param files - each file of the run, with where its box has it.
 * @returns how the run ended, as its result has it.
 */
export async function packIn(
  box: () => Promise<FleetBoxPort>, outcome: Outcome, files: { [name: string]: Envelope['files'][string] & { place?: string } }, file: string, scratch: string,
): Promise<Outcome> {
  let ended: Outcome = outcome.ok ? { ok: true, text: outcome.text } : outcome
  try {
    if (ended.ok) {
      try {
        const running = await box()
        const at: { [name: string]: string } = {}
        for (const [name, { mode, place }] of Object.entries(files)) {
          if (place === undefined) throw new Error(`the box has no place for ${name}`)
          at[name] = join(scratch, place)
          if (mode !== 'in') await fetch(running, place, scratch)
        }
        await pipeline(Readable.from(collect(ended, files, at, scratch)), createWriteStream(file, { mode: 0o600 }))
        // As the caller's adaptor reads it, so a result that would not fit its run is not kept.
        const { json, contents } = await decodeResult(createReadStream(file))
        checkReport(json, files)
        for await (const content of contents) for await (const _ of content.entries);
        return json.failure === undefined ? { ok: json.ok, text: json.text } : { ok: json.ok, text: json.text, failure: json.failure }
      } catch (error) {
        ended = { ok: false, text: outcome.text, failure: `could not get back what the run gave: ${inBox(messageOf(error), scratch)}` }
      }
    }
    await pipeline(Readable.from(packResult({ ...ended, outputs: {} }, {})), createWriteStream(file, { mode: 0o600 }))
    return ended
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Get what is at `place` in the box into `scratch`, at the same path there: a folder's contents, a file under its own name, nothing if nothing is there. */
async function fetch(box: FleetBoxPort, place: string, scratch: string): Promise<void> {
  const info = (await box.api.stat({ path: place })).info
  if (info === undefined) return
  const into = info.type === FileType.DIRECTORY ? join(scratch, place) : join(scratch, posix.dirname(place))
  await mkdir(into, { recursive: true })
  try {
    await unpackTree(box.get(place), into, { what: `what the agent left at ${place}` })
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.NotFound) return
    throw error
  }
}

/**
 * The result's archive of a run that ended as `outcome` says, as tau's
 * backend SDK collects it: if it succeeded, what is at each `out` and
 * `inout` file's place, `at`, checked; if that does not fit, a run that
 * failed, giving back nothing.
 */
function collect(outcome: Outcome, files: Envelope['files'], at: { [name: string]: string }, scratch: string): AsyncIterable<Uint8Array> {
  let result = outcome
  try {
    checkOutputs({ files }, at)
  } catch (error) {
    result = { ok: false, text: outcome.text, failure: inBox(messageOf(error), scratch) }
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

/** What a check here says, its paths the box's, as the agent knows them, not where they were got back to. */
function inBox(text: string, scratch: string): string {
  return text.replaceAll(scratch, '')
}

/** Each place, where `at` has it. */
function rooted(places: { [name: string]: string }, at: (path: string) => string): { [name: string]: string } {
  return Object.fromEntries(Object.entries(places).map(([name, place]) => [name, at(place)]))
}

function isDir(path: string): Promise<boolean> {
  return stat(path).then(info => info.isDirectory(), () => false)
}

/** What the tau exposes, with where the box has each, and what it says it is, as its layout has them. */
export function exposedIn({ packages }: Setup): Entry['exposed'] {
  return packages.map(({ name, dir, description }) => ({ specifier: name, dir, ...description === undefined ? {} : { description } }))
}

/** Each file of a run, as it was admitted, with where its box has it, as its layout placed it. */
export function placed({ files }: Accepted, { places }: Setup): Entry['files'] {
  return Object.fromEntries(Object.entries(files).map(([name, file]) => {
    const place = places[name]
    if (place === undefined) throw new Error(`dsh-tau: the layout placed no file ${name}`)
    return [name, { ...file, place }]
  }))
}
