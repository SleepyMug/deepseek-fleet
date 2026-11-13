/**
 * What the gateway alone asks of the helper, `Provision`: the tree of the
 * box's things of fleet's, which the gateway composes from the box's
 * services, installed at the layout's `fleet`, each of the tree's places
 * (fleet-protocol's layout, `TREE`) in place of what was there, whatever
 * else is there, as the box's programs, kept; and its digest kept beside
 * it, so that a box started again, which holds it already, is not given it
 * again.
 * @module @sleepymug/fleet-box/helper/provision
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { InstallRequest } from '@sleepymug/fleet-protocol/box'
import { TREE, type BoxLayout } from '@sleepymug/fleet-protocol/layout'
import { unpackTree } from '@sleepymug/fleet-pack'
import { invalid, systemError } from './errors.ts'

/** The file beside what is installed that names its digest. */
const DIGEST = '.digest'

export class Provision {
  constructor(private readonly layout: BoxLayout) {}

  async installed(): Promise<{ digest: string }> {
    const digest = await readFile(join(this.layout.fleet, DIGEST), 'utf8').catch(() => '')
    return { digest: digest.trim() }
  }

  /** Install the tree the requests carry, whole, or leave what was there. */
  async install(requests: AsyncIterable<InstallRequest>): Promise<object> {
    const iterator = requests[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done === true || first.value.part.case !== 'digest') throw invalid('an install starts with the digest of what it installs')
    const digest = first.value.part.value
    const chunks = async function* () {
      for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
        if (next.value.part.case === 'chunk') yield next.value.part.value
        else throw invalid('an install names its digest once')
      }
    }
    const target = this.layout.fleet
    const staging = `${target}.new`
    try {
      await rm(staging, { recursive: true, force: true })
      await mkdir(dirname(target), { recursive: true })
      await unpackTree(chunks(), staging, { what: 'the box\'s tree' })
      await mkdir(target, { recursive: true })
      // The digest goes first, so that a tree cut short is installed again.
      await rm(join(target, DIGEST), { force: true })
      for (const place of Object.values(TREE)) {
        await rm(join(target, place), { recursive: true, force: true })
        await rename(join(staging, place), join(target, place)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
      await writeFile(join(target, DIGEST), `${digest}\n`)
      await rm(staging, { recursive: true, force: true })
      return {}
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      throw systemError(error, 'install the box\'s tree')
    }
  }
}
