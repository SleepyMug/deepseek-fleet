/**
 * Copy a path out of a session's container through its helper, as the host
 * reads the container's files for the file viewer: the host walks the path
 * with the helper's `lstat` and `listDir`, reads each file in ranges, and
 * writes plain files and folders of its own, with the host's usual
 * permissions, as its umask leaves them. The container is the model's,
 * so nothing it holds is taken as more than that: a symlink, or anything
 * that is neither a file nor a folder, refuses the copy, and so does more
 * than the byte limit. `docker cp` would do neither, and under rootless
 * Docker it cannot copy from, or into, a container with a read-only bind
 * mount whose source filesystem is mounted nosuid, nodev or noexec, such as
 * a tmpfs /tmp: the daemon remounts the bind read-only without restating
 * those flags, which a user namespace keeps locked.
 * @module fleet-box/copy-out
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { z } from 'zod'
import type { HelperConnection } from './connection.ts'

/** Bytes read from the container per request. */
const CHUNK_BYTES = 4 * 1024 * 1024

const targetSchema = z.object({ targetKey: z.string(), displayPath: z.string() })
const pathInfoSchema = z.object({ type: z.enum(['file', 'directory', 'symlink', 'other']), size: z.number().nonnegative().optional() }).nullable()
const entriesSchema = z.array(z.object({ name: z.string() }))

/**
 * @param connection - the helper of the container to copy from.
 * @param source - an absolute path in the container.
 * @param target - a host path that does not exist yet, which becomes the copy.
 * @param maxBytes - the most the copy may hold.
 * @returns whether there was anything at `source` to copy.
 * @throws naming what was refused, or when the container could not be read.
 */
export async function copyOut(connection: Pick<HelperConnection, 'request'>, source: string, target: string, maxBytes: number, signal?: AbortSignal): Promise<boolean> {
  let copied = 0
  const copy = async (from: string, to: string): Promise<void> => {
    const info = await connection.request('fs.lstat', { path: from }, pathInfoSchema, signal)
    if (info === null) throw new Error(`${from} went away while it was copied`)
    if (info.type === 'symlink') throw new Error(`${from} is a symlink, which is not copied out`)
    if (info.type === 'other') throw new Error(`${from} is neither a file nor a folder`)
    const resolved = await connection.request('fs.resolve', { path: from }, targetSchema, signal)
    if (info.type === 'directory') {
      await mkdir(to)
      const entries = await connection.request('fs.listDir', { target: resolved }, entriesSchema, signal)
      for (const { name } of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (name === '' || name === '.' || name === '..' || name.includes('/')) throw new Error(`${from} lists an entry named ${JSON.stringify(name)}`)
        await copy(posix.join(from, name), join(to, name))
      }
      return
    }
    await writeFile(to, '', { flag: 'wx' })
    for (let offset = 0; ; offset += CHUNK_BYTES) {
      const chunk = Buffer.from(await connection.request('fs.readRange', { target: resolved, offset, length: CHUNK_BYTES }, z.string(), signal), 'base64')
      copied += chunk.length
      if (copied > maxBytes) throw new Error(`${source} holds more than ${maxBytes} bytes, the limit for a copy`)
      if (chunk.length > 0) await appendFile(to, chunk)
      if (chunk.length < CHUNK_BYTES) return
    }
  }
  if (await connection.request('fs.lstat', { path: source }, pathInfoSchema, signal) === null) return false
  await copy(source, target)
  return true
}
