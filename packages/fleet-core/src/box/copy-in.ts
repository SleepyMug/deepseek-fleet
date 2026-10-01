/**
 * Copy a host path into a session's container through its helper, the
 * reverse of ./copy-out.ts: the host walks the path and has the helper make
 * each folder, file and symlink in the container, with its permission bits,
 * sending files in chunks. The source is the host's own, such as a snapshot
 * another plugin keeps, so it is taken as it is: a symlink is copied as the
 * link it is, and anything that is neither a file, a folder nor a symlink
 * refuses the copy. Whatever the container had at the target is replaced.
 * `docker cp` would be quicker, but under rootless Docker it cannot copy into
 * a container with a read-only bind mount from a filesystem mounted nosuid,
 * nodev or noexec (./copy-out.ts).
 * @module fleet-core/box/copy-in
 */

import { randomUUID } from 'node:crypto'
import { lstat, open, readdir, readlink } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { z } from 'zod'
import { INCOMING } from 'fleet-image/helper/protocol'
import type { HelperConnection } from './connection.ts'

/** Bytes sent to the container per request. */
const CHUNK_BYTES = 4 * 1024 * 1024

/**
 * @param connection - the helper of the container to copy into.
 * @param source - an absolute host path.
 * @param target - an absolute path in the container, whose folder is made if it is missing.
 * @throws when the source holds something that is not copied, or the container refuses a part.
 */
export async function copyIn(connection: Pick<HelperConnection, 'request'>, source: string, target: string, signal?: AbortSignal): Promise<void> {
  const request = (method: string, params: Record<string, unknown>): Promise<null> => connection.request(method, params, z.null(), signal)
  const copy = async (from: string, to: string): Promise<void> => {
    const info = await lstat(from)
    const mode = info.mode & 0o777
    if (info.isSymbolicLink()) {
      await request('copyIn.symlink', { path: to, link: await readlink(from) })
    } else if (info.isDirectory()) {
      await request('copyIn.dir', { path: to, mode })
      for (const name of (await readdir(from)).sort()) await copy(join(from, name), posix.join(to, name))
    } else if (info.isFile()) {
      const file = await open(from)
      try {
        const buffer = Buffer.alloc(CHUNK_BYTES)
        for (let first = true; ; first = false) {
          const { bytesRead } = await file.read(buffer, 0, CHUNK_BYTES, null)
          const data = buffer.subarray(0, bytesRead).toString('base64')
          if (first) await request('copyIn.file', { path: to, mode, data })
          else if (bytesRead > 0) await request('copyIn.append', { path: to, data })
          if (bytesRead < CHUNK_BYTES) return
        }
      } finally {
        await file.close()
      }
    } else {
      throw new Error(`${from} is neither a file, a folder nor a symlink, which is not copied in`)
    }
  }
  await request('copyIn.begin', { path: target })
  await copy(source, target)
}

/**
 * Copy a host path into the container and put it in place of what is at
 * `target` there, as fleet-tau publishes an output on the host: copied into
 * the container's {@link INCOMING} first, so nothing at `target` changes
 * unless the whole copy got there, then renamed in, a folder over a folder
 * entry by entry, and everything put back if that fails (fleet-image's
 * replace.ts).
 * @param target - an absolute path in the container.
 */
export async function replaceIn(connection: Pick<HelperConnection, 'request'>, source: string, target: string, signal?: AbortSignal): Promise<void> {
  const incoming = posix.join(INCOMING, randomUUID())
  try {
    await copyIn(connection, source, incoming, signal)
  } catch (error) {
    // What was copied so far goes; nothing at the target was touched.
    await connection.request('copyIn.begin', { path: incoming }, z.null()).catch(() => {})
    throw error
  }
  await connection.request('copyIn.replace', { source: incoming, path: target }, z.null(), signal)
}
