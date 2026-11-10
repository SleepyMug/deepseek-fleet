/**
 * A run's box, as dsh-tau has its half there set it up from the run's call,
 * and pack the run's result (dsh-tau-box's protocol): the half places
 * everything where the box has things and reports where; and, once the run
 * ended, it packs what the agent left at the places of the `out` and
 * `inout` files, which is checked here against the run, since the box is
 * the agent's.
 * @module @sleepymug/dsh-tau/tau/box-setup
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { checkReport, type Envelope } from '@sleepymug/tau/core'
import { decodeResult, packResult } from '@sleepymug/tau/wire-tar'
import { requestPack, requestSetup, type Setup } from '@sleepymug/dsh-tau-box/protocol'
import type { Result } from '@sleepymug/dsh-tau-box/runs'
import { messageOf } from '../util/error.ts'
import type { Accepted } from './admission.ts'
import type { FleetBoxPort } from './ports.ts'
import type { Entry } from './registry.ts'

/**
 * Have a started box's half set it up from the run's call.
 * @param call - the file of the run's call, as it was admitted.
 * @returns what the half reported.
 */
export async function furnish(box: FleetBoxPort, call: string): Promise<Setup> {
  return await requestSetup((argv, io) => box.pipe(argv, io), call)
}

/** What the tau exposes, with where the box has each, and what it says it is, as the box's half reported it. */
export function exposedIn({ packages }: Setup): Entry['exposed'] {
  return packages.map(({ name, dir, description }) => ({ specifier: name, dir, ...description === undefined ? {} : { description } }))
}

/** Each file of a run, as it was admitted, with where its box has it, as the box's half reported. */
export function placed({ files }: Accepted, { places }: Setup): Entry['files'] {
  return Object.fromEntries(Object.entries(files).map(([name, file]) => {
    const place = places[name]
    if (place === undefined) throw new Error(`dsh-tau: the box's half placed no file ${name}`)
    return [name, { ...file, place }]
  }))
}

/**
 * Keep the result of a run, which ended as `outcome` says, in `file`: for
 * a run that succeeded, as its box packs it, failing the run when that does
 * not fit the run's files, or the box cannot; a run that failed gives back
 * nothing.
 * @param box - gives the run's box, asked for only when a run succeeded.
 * @returns how the run ended, as its result has it.
 */
export async function packIn(box: () => Promise<FleetBoxPort>, outcome: Result, files: Envelope['files'], file: string): Promise<Result> {
  let ended = outcome
  if (ended.ok) {
    try {
      const running = await box()
      await requestPack((argv, io) => running.pipe(argv, io), outcome, file)
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
