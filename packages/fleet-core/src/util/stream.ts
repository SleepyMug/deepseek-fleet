/**
 * @module @sleepymug/fleet-core/util/stream
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
