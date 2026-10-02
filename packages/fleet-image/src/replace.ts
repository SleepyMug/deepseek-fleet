/**
 * Putting a copy in place of a path, as fleet-tau publishes an `out` path:
 * on the host, the caller's path for a run started there (fleet-core's
 * tau/outputs.ts), and in the caller's container, through the helper, for a
 * run started there (./helper/main.ts). Shared by the host and the helper.
 * @module fleet-image/replace
 */

import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Put a copy in place of a path, in a folder made for it if an `out` path
 * published before it left none. The copy is copied beside the path first,
 * onto its file system, and then renamed in, what was there set aside just
 * before and removed after, so the path holds the old or the new, never a
 * mix of the two. A failure puts back what was set aside, and should that
 * fail too, leaves it where the error says.
 * @param host - the path to replace, whether the host's or a container's.
 */
export async function replace(host: string, copy: string): Promise<void> {
  const incoming = `${host}.fleet-${randomUUID()}`
  const aside = `${host}.fleet-old-${randomUUID()}`
  await mkdir(dirname(host), { recursive: true })
  try {
    await cp(copy, incoming, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
    const had = await lstat(host).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (had) await rename(host, aside)
    try {
      await rename(incoming, host)
    } catch (error) {
      if (had) {
        await rename(aside, host).catch((putBack: unknown) => {
          throw new Error(`${message(error)}; what was there is in ${aside}, which could not be put back: ${message(putBack)}`, { cause: error })
        })
      }
      throw error
    }
    await rm(aside, { recursive: true, force: true })
  } finally {
    await rm(incoming, { recursive: true, force: true })
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
