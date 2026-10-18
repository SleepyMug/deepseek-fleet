/**
 * A run's box, as the host has its tau runtime set it up from the run's
 * call, and pack the run's result (fleet-box-runtime/tau/protocol): the
 * runtime places everything where the box has things and reports where,
 * and here each API's client, and its contract's package.json and
 * declarations, are copied in where it says, and the APIs and what the tau
 * exposes linked, by the box's helper; and, once the run
 * ended, the runtime packs what the agent left at the places of the `out`
 * and `inout` files, which is checked here against the run, since the box
 * is the agent's.
 * @module @sleepymug/fleet-core/tau/box-setup
 */

import { createReadStream, createWriteStream, statSync } from 'node:fs'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { checkReport, type Envelope } from '@sleepymug/tau/core'
import { decodeResult, packResult } from '@sleepymug/tau/wire-tar'
import { requestPack, requestSetup, type Setup } from '@sleepymug/fleet-box-runtime/tau/protocol'
import type { Result } from '@sleepymug/fleet-protocol/tau'
import { messageOf } from '../util/error.ts'
import type { Accepted } from './admission.ts'
import type { RunBox } from './ports.ts'
import type { Entry } from './registry.ts'

/**
 * Have a started box's runtime set it up from the run's call, offered the
 * contracts the call was admitted with, copy each API's client, and its
 * contract's package.json and declarations, in, where the runtime says,
 * and link the APIs and what the tau exposes.
 * @param call - the file of the run's call, as it was admitted.
 * @returns what the runtime reported.
 */
export async function furnish(box: RunBox, call: string, { links }: Accepted): Promise<Setup> {
  const offered = links.map(({ contract, version }) => ({ contract, version }))
  const setup = await requestSetup((argv, io) => box.pipe(argv, io), createReadStream(call), offered)
  const copied = new Set<string>()
  for (const { contract, client, declarations } of setup.links) {
    const ext = links.find(link => link.contract === contract)
    if (ext === undefined) throw new Error(`fleet: the box's runtime linked ${contract}, which it was not offered`)
    if (copied.has(client) || copied.has(declarations)) continue
    copied.add(client).add(declarations)
    await box.copyIn(ext.client, client)
    // Beside the call, in the run's own folder.
    const staged = await mkdtemp(join(dirname(call), 'contract-'))
    try {
      await stageDeclarations(ext.declarations, join(staged, 'contract'))
      await box.copyIn(join(staged, 'contract'), declarations)
    } finally {
      await rm(staged, { recursive: true, force: true })
    }
  }
  await box.request('apis.link', {
    modules: setup.modules,
    apis: setup.links.map(({ contract, client, declarations }) => ({ name: contract, client, types: declarations })),
    packages: setup.packages,
  })
  return setup
}

/** Copy what the agent reads of a contract's package, its package.json and declarations, but those of its node_modules, from `from` to `to`. */
async function stageDeclarations(from: string, to: string): Promise<void> {
  await cp(from, to, {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const at = relative(from, source)
      if (at === '') return true
      if (at.split(sep).includes('node_modules')) return false
      return at === 'package.json' || at.endsWith('.d.ts') || statSync(source).isDirectory()
    },
  })
}

/**
 * What the tau exposes, as it was admitted, with where the box has the
 * declarations of each API, as the box's runtime reported it.
 */
export function exposedIn({ exposed }: Accepted, { links }: Setup): Entry['exposed'] {
  return exposed.map(entry => {
    if (entry.kind === 'package') return { specifier: entry.specifier, ...entry.description === undefined ? {} : { description: entry.description } }
    const link = links.find(({ contract }) => contract === entry.specifier)
    if (link === undefined) throw new Error(`fleet: the box's runtime linked no ${entry.specifier}, which the tau exposes`)
    return { specifier: entry.specifier, ...entry.description === undefined ? {} : { description: entry.description }, declarations: link.declarations }
  })
}

/** Each file of a run, as it was admitted, with where its box has it, as the box's runtime reported. */
export function placed({ files }: Accepted, { places }: Setup): Entry['files'] {
  return Object.fromEntries(Object.entries(files).map(([name, file]) => {
    const place = places[name]
    if (place === undefined) throw new Error(`fleet: the box's runtime placed no file ${name}`)
    return [name, { ...file, place }]
  }))
}

/**
 * Keep the result of a run, which ended as `outcome` says, in `file`: for
 * a run that succeeded, as its box packs it, failing the run when that does
 * not fit the run's files, or the box cannot; a run that failed gives back
 * nothing.
 * @param box - gives the run's started box, asked for only when a run succeeded.
 * @returns how the run ended, as its result has it.
 */
export async function packIn(box: () => Promise<RunBox>, outcome: Result, files: Envelope['files'], file: string): Promise<Result> {
  let ended = outcome
  if (ended.ok) {
    try {
      const running = await box()
      await requestPack((argv, io) => running.pipe(argv, io), outcome, createWriteStream(file, { mode: 0o600 }))
      const { json, contents } = await decodeResult(createReadStream(file))
      if (json.text !== outcome.text) throw new Error('its text is not the agent\'s')
      checkReport(json, files)
      for await (const content of contents) for await (const _ of content.entries);
      return json.failure === undefined ? { ok: json.ok, text: json.text } : { ok: json.ok, text: json.text, failure: json.failure }
    } catch (error) {
      ended = { ok: false, text: outcome.text, failure: `could not get back what the run gave: ${messageOf(error)}` }
    }
  }
  await pipeline(Readable.from(packResult({ ...ended, outputs: {} }, {})), createWriteStream(file, { mode: 0o600 }))
  return ended
}
