/**
 * Trees kept by their digest (fleet-pack's), each a folder in the store
 * named by it, so that the same tree is kept once, and a tree is known by
 * what it holds: a service's package, as its server uploads it; a
 * service's client, as the gateway makes it; and what the clients import.
 * A tree comes in whole or not at all, and is never changed once in.
 * @module @sleepymug/fleet/store
 */

import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { digestOf, unpackTree } from '@sleepymug/fleet-pack'

const DIGEST = /^[0-9a-f]{64}$/u

/** A tree whose digest is not what was said of it. */
export class DigestMismatch extends Error {}

export class Store {
  constructor(private readonly dir: string) {}

  /** Where the tree with `digest` is. */
  path(digest: string): string {
    if (!DIGEST.test(digest)) throw new Error(`fleet: ${JSON.stringify(digest)} is no digest`)
    return join(this.dir, digest)
  }

  async has(digest: string): Promise<boolean> {
    return DIGEST.test(digest) && await stat(this.path(digest)).then(info => info.isDirectory(), () => false)
  }

  /** Take in the tree `archive` carries, which must have `digest`. */
  async receive(digest: string, archive: AsyncIterable<Uint8Array>): Promise<void> {
    const target = this.path(digest)
    const incoming = await this.incoming()
    try {
      await unpackTree(archive, incoming, { what: `the tree ${digest}` })
      const found = await digestOf(incoming)
      if (found !== digest) throw new DigestMismatch(`fleet: the tree said to be ${digest} is ${found}`)
      await this.settle(incoming, target)
    } finally {
      await rm(incoming, { recursive: true, force: true })
    }
  }

  /** Take in the tree `make` writes in the folder it is given, and give its digest. */
  async make(write: (dir: string) => Promise<void>): Promise<string> {
    const incoming = await this.incoming()
    try {
      await write(incoming)
      const digest = await digestOf(incoming)
      await this.settle(incoming, this.path(digest))
      return digest
    } finally {
      await rm(incoming, { recursive: true, force: true })
    }
  }

  /** A folder of the store's own to write a tree in before it is in. */
  private async incoming(): Promise<string> {
    const dir = join(this.dir, `.incoming-${randomBytes(8).toString('hex')}`)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  /** Move a tree in, unless the same tree is in already. */
  private async settle(incoming: string, target: string): Promise<void> {
    if (await stat(target).then(() => true, () => false)) return
    await rename(incoming, target).catch(async (error: NodeJS.ErrnoException) => {
      // Another took the same tree in meanwhile.
      if (!(await stat(target).then(() => true, () => false))) throw error
    })
  }
}
