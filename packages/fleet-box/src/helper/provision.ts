/**
 * What the gateway alone asks of the helper, `Provision`: the tree of the
 * box's things of fleet's, which the gateway composes from the box's
 * services, installed at the layout's `fleet`, each of the tree's places
 * (fleet-protocol's layout, `TREE`) in place of what was there, whatever
 * else is there, as the box's programs, kept. Which tree the box holds is
 * the gateway's to keep, in the box's record.
 * @module @sleepymug/fleet-box/helper/provision
 */

import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { InstallRequest } from '@sleepymug/fleet-protocol/box'
import { TREE, type BoxLayout } from '@sleepymug/fleet-protocol/layout'
import { unpackTree } from '@sleepymug/fleet-pack'
import { systemError } from './errors.ts'

export class Provision {
  constructor(private readonly layout: BoxLayout) {}

  /** Install the tree the requests carry, whole, or leave what was there. */
  async install(requests: AsyncIterable<InstallRequest>): Promise<object> {
    const chunks = async function* () {
      for await (const request of requests) yield request.chunk
    }
    const target = this.layout.fleet
    const staging = `${target}.new`
    try {
      await rm(staging, { recursive: true, force: true })
      await mkdir(dirname(target), { recursive: true })
      await unpackTree(chunks(), staging, { what: 'the box\'s tree' })
      await mkdir(target, { recursive: true })
      for (const place of Object.values(TREE)) {
        await rm(join(target, place), { recursive: true, force: true })
        await rename(join(staging, place), join(target, place)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
      await rm(staging, { recursive: true, force: true })
      return {}
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      throw systemError(error, 'install the box\'s tree')
    }
  }
}
