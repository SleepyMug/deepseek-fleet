/**
 * An example service that takes bytes, `archives` (manifests/archives.d.ts):
 * it receives the tarballs a session sends, as a `Uint8Array`, which calls
 * carry as base64, and keeps a receipt of each per session, in the fleet
 * host's memory until it exits. fleet-tau's patch lists it disabled. An
 * agent directory with a copy of the manifest in its api/ can call it, as
 * examples/archive-dir in this repository does.
 * @module fleet-tau/examples/archives
 */

import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '../services.ts'

export const name = 'fleet-tau-archives'
export const inject = ['fleetServices']

interface Receipt {
  name: string
  bytes: number
  sha256: string
  entries: string[]
}

export async function apply(ctx: Context): Promise<void> {
  const receipts = new Map<SessionId, Map<string, Receipt>>()
  const dispose = await ctx.fleetServices.provide({
    manifest: fileURLToPath(new URL('../../manifests/archives.d.ts', import.meta.url)),
    functions: {
      store: ([name, tarball], { session }) => {
        const bytes = tarball as Uint8Array
        const receipt: Receipt = { name: name as string, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), entries: tarEntries(bytes) }
        let kept = receipts.get(session)
        if (kept === undefined) receipts.set(session, kept = new Map())
        // Replaced in place of the earlier one, so the list is oldest first.
        kept.delete(receipt.name)
        kept.set(receipt.name, receipt)
        return { ...receipt, entries: [...receipt.entries] }
      },
      list: (_args, { session }) => [...receipts.get(session)?.values() ?? []].map(receipt => ({ ...receipt, entries: [...receipt.entries] })),
    },
  })
  ctx.effect(() => dispose, 'the archives service')
}

const BLOCK = 512
const decoder = new TextDecoder()

/**
 * The paths an uncompressed tarball holds, in its order, as tar lists them
 * without a leading `./`, and without `.` itself: from ustar headers, with
 * GNU tar's long names and pax `path` records.
 * @throws when it is no such tarball.
 */
export function tarEntries(tarball: Uint8Array): string[] {
  const field = (at: number, length: number): string => decoder.decode(tarball.subarray(at, at + length)).split('\0', 1)[0]!
  const entries: string[] = []
  /** The next entry's path, from a GNU long name or a pax record before it. */
  let long: string | undefined
  const notTar = (at: number): Error => new Error(`no tar header at byte ${at}; send an uncompressed tarball, as \`tar -cf\` writes one`)
  for (let at = 0; ;) {
    if (at + BLOCK > tarball.length) throw at === 0 ? notTar(at) : new Error('the tarball ends before its end-of-archive blocks')
    if (tarball.subarray(at, at + BLOCK).every(byte => byte === 0)) return entries
    const magic = field(at + 257, 6)
    if (!magic.startsWith('ustar')) throw notTar(at)
    const size = Number.parseInt(field(at + 124, 12).trim() || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`the tar header at byte ${at} has no size`)
    const type = field(at + 156, 1)
    const data = decoder.decode(tarball.subarray(at + BLOCK, at + BLOCK + size))
    // POSIX ustar splits a long path into a prefix and a name; GNU tar keeps other fields there.
    const prefix = magic === 'ustar' ? field(at + 345, 155) : ''
    const name = field(at, 100)
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK
    if (type === 'L') long = data.split('\0', 1)[0]
    else if (type === 'x') long = /(?:^|\n)\d+ path=([^\n]*)\n/u.exec(data)?.[1] ?? long
    else if (type !== 'g' && type !== 'K') {
      const path = (long ?? (prefix === '' ? name : `${prefix}/${name}`)).replace(/^\.\//u, '')
      long = undefined
      if (path !== '' && path !== '.') entries.push(path)
    }
  }
}
