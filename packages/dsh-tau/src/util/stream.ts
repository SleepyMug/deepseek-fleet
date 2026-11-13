/**
 * @module @sleepymug/dsh-tau/util/stream
 */

import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'

/** `bytes`, as they are read, written to `file` too, which is whole once they are all read. */
export async function* spool(bytes: AsyncIterable<Uint8Array>, file: string): AsyncGenerator<Uint8Array> {
  const out = createWriteStream(file, { mode: 0o600 })
  try {
    for await (const chunk of bytes) {
      if (!out.write(chunk)) await once(out, 'drain')
      yield chunk
    }
  } finally {
    out.end()
    await finished(out)
  }
}

/** `items`, as a stream, such as a call's requests that are known at once. */
export async function* streamOf<T>(...items: T[]): AsyncGenerator<T> {
  yield* items
}

/**
 * A stream that items are pushed into as they come, such as a call's
 * requests while the call lasts, read once; it ends once ended, after what
 * was pushed before.
 */
export class Pushed<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private ended = false
  private wake: (() => void) | undefined

  push(item: T): void {
    if (this.ended) return
    this.items.push(item)
    this.wake?.()
  }

  end(): void {
    this.ended = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const item = this.items.shift()
      if (item !== undefined) {
        yield item
        continue
      }
      if (this.ended) return
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
  }
}
