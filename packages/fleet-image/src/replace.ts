/**
 * Putting a copy in place of a path, as fleet-tau publishes an `out` path:
 * on the host, the caller's path for a run started there (fleet-core's
 * tau/outputs.ts), and in the caller's container, through the helper, for a
 * run started there (./helper/main.ts). Shared by the host and the helper.
 * @module fleet-image/replace
 */

import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Put a copy in place of a path, in a folder made for it if an `out` path
 * published before it left none. The copy is copied beside the path first,
 * onto its file system, and then renamed in: a folder over a folder entry by
 * entry, recursively, so a folder that stays a folder is the same folder
 * after, which a mount of it, such as a container's of the workspace dir,
 * and whatever has it open keep seeing. What was there is
 * set aside, and removed once the copy is in place; a failure renames
 * everything back, and should that fail too, leaves what was set aside where
 * the error says.
 * @param host - the path to replace, whether the host's or a container's.
 */
export async function replace(host: string, copy: string): Promise<void> {
  const incoming = `${host}.fleet-${randomUUID()}`
  const aside = `${host}.fleet-old-${randomUUID()}`
  /** Each rename done, which a failure undoes in reverse. */
  const moved: [from: string, to: string][] = []
  /** Whether nothing of the caller's is left in `aside`. */
  let restored = true
  const move = async (from: string, to: string): Promise<void> => {
    await rename(from, to)
    moved.push([from, to])
  }
  const put = async (target: string, source: string): Promise<void> => {
    const [had, comes] = await Promise.all([lstat(target).catch(() => undefined), lstat(source)])
    if (had?.isDirectory() === true && comes.isDirectory()) {
      const entries = new Set(await readdir(source))
      for (const entry of await readdir(target)) {
        if (!entries.has(entry)) await move(join(target, entry), join(aside, String(moved.length)))
      }
      for (const entry of entries) await put(join(target, entry), join(source, entry))
      return
    }
    if (had !== undefined) await move(target, join(aside, String(moved.length)))
    await move(source, target)
  }
  try {
    await mkdir(dirname(host), { recursive: true })
    await cp(copy, incoming, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
    await mkdir(aside)
    await put(host, incoming)
  } catch (error) {
    for (const [from, to] of moved.toReversed()) await rename(to, from).catch(() => { restored = false })
    if (restored) throw error
    throw new Error(`${message(error)}; what could not be put back is in ${aside}, and the copy in ${incoming}`, { cause: error })
  } finally {
    if (restored) {
      await rm(incoming, { recursive: true, force: true })
      await rm(aside, { recursive: true, force: true })
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
