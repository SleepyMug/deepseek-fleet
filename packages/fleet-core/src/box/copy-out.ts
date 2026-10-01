/**
 * Copy a path out of a session's container through its helper, as the host
 * reads the container's files for the file viewer: the host walks the path
 * with the helper's `lstat` and `listDir`, reads each file in ranges, and
 * writes plain files and folders of its own, with the host's usual
 * permissions, as its umask leaves them. The container is the model's,
 * so nothing it holds is taken as more than that: anything that is neither a
 * file, a folder nor a symlink refuses the copy, and so does a symlink,
 * unless the copy keeps them, as when it takes an agent directory, whose
 * symlinks are part of it, or an `in` path (fleet-tau's inputs.ts). Then the
 * path itself is followed, a symlink in it is written as the link it is,
 * never followed, and each file and folder keeps its permission bits, as a
 * snapshot taken on the host does, though a folder stays writable by the
 * host's user, and a file readable. `docker cp` would do none of this, and
 * under rootless Docker it cannot copy from, or into, a container with a
 * read-only bind mount whose source filesystem is mounted nosuid, nodev or
 * noexec, such as a tmpfs /tmp: the daemon remounts the bind read-only
 * without restating those flags, which a user namespace keeps locked.
 * @module fleet-core/box/copy-out
 */

import { appendFile, chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { z } from 'zod'
import type { HelperConnection } from './connection.ts'

/** Bytes read from the container per request. */
const CHUNK_BYTES = 4 * 1024 * 1024

const targetSchema = z.object({ targetKey: z.string(), displayPath: z.string() })
const pathInfoSchema = z.object({ type: z.enum(['file', 'directory', 'symlink', 'other']), size: z.number().nonnegative().optional() }).nullable()
const entriesSchema = z.array(z.object({ name: z.string() }))

export interface CopyOutOptions {
  /** Follow the path, copy each symlink in it as the link it is, rather than refuse the copy, and keep permission bits. */
  links?: boolean
  /** The most the copy may hold; no limit by default. */
  maxBytes?: number
  signal?: AbortSignal
}

/**
 * @param connection - the helper of the container to copy from.
 * @param source - an absolute path in the container.
 * @param target - a host path that does not exist yet, which becomes the copy.
 * @returns whether there was anything at `source` to copy.
 * @throws naming what was refused, or when the container could not be read.
 */
export async function copyOut(connection: Pick<HelperConnection, 'request'>, source: string, target: string, options: CopyOutOptions = {}): Promise<boolean> {
  const { links = false, maxBytes = Number.POSITIVE_INFINITY, signal } = options
  let copied = 0
  const copy = async (from: string, to: string): Promise<void> => {
    const info = await connection.request('fs.lstat', { path: from }, pathInfoSchema, signal)
    if (info === null) throw new Error(`${from} went away while it was copied`)
    if (info.type === 'symlink') {
      if (!links) throw new Error(`${from} is a symlink, which is not copied out`)
      await symlink(await connection.request('copyOut.readlink', { path: from }, z.string(), signal), to)
      return
    }
    if (info.type === 'other') throw new Error(`${from} is neither a file nor a folder`)
    const resolved = await connection.request('fs.resolve', { path: from }, targetSchema, signal)
    const mode = links ? await connection.request('copyOut.mode', { path: from }, z.number().int().nonnegative(), signal) & 0o777 : undefined
    if (info.type === 'directory') {
      await mkdir(to)
      const entries = await connection.request('fs.listDir', { target: resolved }, entriesSchema, signal)
      for (const { name } of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (name === '' || name === '.' || name === '..' || name.includes('/')) throw new Error(`${from} lists an entry named ${JSON.stringify(name)}`)
        await copy(posix.join(from, name), join(to, name))
      }
      if (mode !== undefined) await chmod(to, mode | 0o700)
      return
    }
    await writeFile(to, '', { flag: 'wx' })
    for (let offset = 0; ; offset += CHUNK_BYTES) {
      const chunk = Buffer.from(await connection.request('fs.readRange', { target: resolved, offset, length: CHUNK_BYTES }, z.string(), signal), 'base64')
      copied += chunk.length
      if (copied > maxBytes) throw new Error(`${source} holds more than ${maxBytes} bytes, the limit for a copy`)
      if (chunk.length > 0) await appendFile(to, chunk)
      if (chunk.length < CHUNK_BYTES) break
    }
    if (mode !== undefined) await chmod(to, mode | 0o600)
  }
  let from = source
  if (links) {
    // The path itself is followed, as tau follows a caller's path; what it leads to is copied.
    const found = await connection.request('fs.lstat', { path: source }, pathInfoSchema, signal)
    if (found === null) return false
    from = (await connection.request('fs.resolve', { path: source }, targetSchema, signal)).targetKey
  }
  if (await connection.request('fs.lstat', { path: from }, pathInfoSchema, signal) === null) return false
  await copy(from, target)
  return true
}
