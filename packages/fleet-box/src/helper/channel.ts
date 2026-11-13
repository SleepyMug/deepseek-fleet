/**
 * What a stream answers, as it comes: values pushed from callbacks, such as
 * a program's output, read in order as an async iterable, which ends once
 * the channel is closed, or fails with what failed it. A reader that falls
 * behind is told by `push`, so that the writer can pause its source, and
 * `drained` says when to resume.
 * @module @sleepymug/fleet-box/helper/channel
 */

/** How many values wait before `push` says to pause. */
const HIGH_WATER = 16

export class Channel<T> implements AsyncIterable<T> {
  private readonly waiting: T[] = []
  private wake: (() => void) | undefined
  private ended = false
  private failure: { error: unknown } | undefined
  private readonly drains = new Set<() => void>()

  /** Add a value; false once enough wait that the writer should pause. */
  push(value: T): boolean {
    if (this.ended) return false
    this.waiting.push(value)
    this.signal()
    return this.waiting.length < HIGH_WATER
  }

  /** Run `listener` once the reader has caught up. */
  drained(listener: () => void): void {
    this.drains.add(listener)
  }

  /** End the channel, after what waits; with `error`, fail it once that is read. */
  close(error?: unknown): void {
    if (this.ended) return
    this.ended = true
    if (error !== undefined) this.failure = { error }
    this.signal()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const value = this.waiting.shift()
      if (value !== undefined) {
        if (this.waiting.length === 0) for (const listener of this.drains) listener()
        if (this.waiting.length === 0) this.drains.clear()
        yield value
        continue
      }
      if (this.ended) {
        if (this.failure !== undefined) throw this.failure.error
        return
      }
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}
