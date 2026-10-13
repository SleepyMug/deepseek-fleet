/**
 * A run's box, as the host has its tau runtime (fleet-box-runtime/tau/endpoint)
 * set it up from the run's call, and pack the run's result: the runtime
 * places everything where the box has things and reports where, and here
 * each API's client is copied in where it says, and the APIs and what the
 * tau exposes linked, by the box's helper; and, once the run ended, the
 * runtime packs what the agent left at the places of the `out` and `inout`
 * files, which is checked here against the run, since the box is the
 * agent's.
 * @module @sleepymug/fleet-core/tau/box-setup
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { posix } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { checkReport, type Envelope } from '@sleepymug/tau/core'
import { decodeResult, packResult } from '@sleepymug/tau/wire-tar'
import { HELPER_NODE, TAU_ENTRY } from '@sleepymug/fleet-box-runtime/layout'
import type { Offered, Setup } from '@sleepymug/fleet-box-runtime/tau/endpoint'
import type { Result } from '@sleepymug/fleet-protocol/tau'
import { messageOf } from '../util/error.ts'
import type { Accepted } from './admission.ts'
import type { RunBox } from './ports.ts'

export type { Setup }

/**
 * Have a started box's runtime set it up from the run's call, offered the
 * contracts the call was admitted with, copy each API's client in, where
 * the runtime says, and link the APIs and what the tau exposes.
 * @param call - the file of the run's call, as it was admitted.
 * @returns what the runtime reported.
 */
export async function furnish(box: RunBox, call: string, { links }: Accepted): Promise<Setup> {
  const report = new Report()
  const offered: Offered[] = links.map(({ contract, version }) => ({ contract, version }))
  await box.pipe([HELPER_NODE, TAU_ENTRY, 'setup', JSON.stringify({ offered })], { input: createReadStream(call), output: report })
  const setup = report.setup()
  const copied = new Set<string>()
  for (const { contract, client } of setup.links) {
    const ext = links.find(link => link.contract === contract)
    if (ext === undefined) throw new Error(`fleet: the box's runtime linked ${contract}, which it was not offered`)
    if (copied.has(client)) continue
    copied.add(client)
    await box.copyIn(ext.client, client)
  }
  await box.request('apis.link', {
    modules: setup.modules,
    apis: setup.links.map(({ alias, client }) => ({ name: alias, client, types: posix.join(setup.self, 'api', alias) })),
    packages: setup.packages,
  })
  return setup
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
      await (await box()).pipe([HELPER_NODE, TAU_ENTRY, 'pack', JSON.stringify({ outcome })], { output: createWriteStream(file, { mode: 0o600 }) })
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

/**
 * What the box's runtime reports of a run it set up. It runs before the
 * agent does, on the call the host checked, so it is taken as it is, once
 * it has the shape of one.
 */
class Report extends Writable {
  private readonly chunks: Buffer[] = []

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.chunks.push(chunk)
    done()
  }

  setup(): Setup {
    const text = Buffer.concat(this.chunks).toString('utf8')
    let setup: Partial<Setup>
    try {
      setup = JSON.parse(text) as Partial<Setup>
    } catch {
      throw new Error(`fleet: the box's runtime reported something else than JSON: ${text.slice(0, 200)}`)
    }
    const absolute = (path: unknown): boolean => typeof path === 'string' && posix.isAbsolute(path)
    const paths = [setup.cwd, setup.modules, setup.self]
    if (typeof setup.prompt !== 'string' || !['string', 'undefined'].includes(typeof setup.init) || !paths.every(absolute)
      || !Array.isArray(setup.links) || !setup.links.every(link => typeof link?.alias === 'string' && typeof link.contract === 'string' && absolute(link.client))
      || !Array.isArray(setup.packages) || !setup.packages.every(entry => typeof entry?.name === 'string' && absolute(entry.dir))) {
      throw new Error('fleet: the box\'s runtime reported no setup')
    }
    return setup as Setup
  }
}
