/**
 * Admitting a run's call, as tau's backend SDK does (tau's
 * docs/spec/backend.md): its tau, which comes first, read into a folder of
 * its own, the call checked against it, and then every content read, and so
 * the whole call checked, before anything is made of it. Where the box
 * places each file is its own (./box-setup.ts); here, only whether the call
 * fits.
 * @module @sleepymug/dsh-tau/tau/admission
 */

import { rm } from 'node:fs/promises'
import { type Admitted, createBackendSdk } from '@sleepymug/tau/backend'
import type { Envelope } from '@sleepymug/tau/core'
import { extractContent } from '@sleepymug/tau/transfer'
import { decodeCall } from '@sleepymug/tau/wire-tar'
import { messageOf } from '../util/error.ts'

/** What dsh-tau learns of a call before it makes anything of it, as it admits it. */
export interface Accepted {
  /** Each file of the call, checked against the tau, with what `tau.json` says it is, for a file it declares. */
  files: { [name: string]: Envelope['files'][string] & { description?: string } }
  /** The names of the tau's skills. */
  skills: string[]
}

export interface AdmitOptions {
  /** A folder the tau is read into, which is removed once the call is admitted, or refused. */
  scratch: string
  /** What names the tau in a refusal, in place of `scratch`. */
  title: string
}

/** Admit a call, tau's archive of the run's envelope, the tau, and the content of its files. */
export async function admit(call: AsyncIterable<Uint8Array>, { scratch, title }: AdmitOptions): Promise<Accepted> {
  try {
    return await read(call, scratch)
  } catch (error) {
    throw new Error(messageOf(error).replaceAll(scratch, `the tau ${title}`), { cause: error })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function read(call: AsyncIterable<Uint8Array>, tauDir: string): Promise<Accepted> {
  const { json, contents } = await decodeCall(call)
  let admitted: Admitted | undefined
  for await (const content of contents) {
    if (content.file !== undefined) {
      if (admitted === undefined) throw new Error('dsh-tau: the call breaks the spec: its tau does not come first')
      for await (const _ of content.entries);
      continue
    }
    await extractContent(content, tauDir)
    try {
      admitted = createBackendSdk().admit(json, tauDir)
    } catch (error) {
      throw new Error(`dsh-tau: ${messageOf(error)}`, { cause: error })
    }
  }
  if (admitted === undefined) throw new Error('dsh-tau: the call breaks the spec: it carries no tau')
  const { envelope, tau } = admitted
  return {
    files: Object.fromEntries(Object.entries(envelope.files).map(([name, file]) => {
      const description = tau.files[name]?.description
      return [name, description === undefined ? file : { ...file, description }]
    })),
    skills: tau.skills.map(skill => skill.name),
  }
}
