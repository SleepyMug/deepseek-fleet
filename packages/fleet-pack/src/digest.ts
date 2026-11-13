/**
 * The digest of a folder as it is: each entry's path, kind and permission
 * bits, a file's bytes and a link's target, in order of path, so that the
 * same tree has the same digest wherever it is, and any change another.
 * @module @sleepymug/fleet-pack/digest
 */

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'

/** The SHA-256 of the tree at `dir`, in hex. */
export async function digestOf(dir: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (at: string, path: string): Promise<void> => {
    const names = (await readdir(at)).sort()
    for (const name of names) {
      const file = join(at, name)
      const relative = path === '' ? name : `${path}/${name}`
      const stats = await lstat(file)
      const mode = (stats.mode & 0o777).toString(8)
      if (stats.isSymbolicLink()) hash.update(`l ${relative} ${await readlink(file)}\n`)
      else if (stats.isDirectory()) {
        hash.update(`d ${relative} ${mode}\n`)
        await walk(file, relative)
      } else {
        const bytes = await readFile(file)
        hash.update(`f ${relative} ${mode} ${bytes.length}\n`)
        hash.update(bytes)
      }
    }
  }
  await walk(dir, '')
  return hash.digest('hex')
}
