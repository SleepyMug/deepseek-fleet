/**
 * Operations run one after another: each starts once the one before it
 * settled, whether it succeeded or failed.
 * @module @sleepymug/fleet-core/util/queue
 */

/** One line of operations. */
export class Queue {
  private last: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.last.then(operation)
    this.last = next.then(() => {}, () => {})
    return next
  }
}

/** A line of operations for each key, such as a session; a key's line is forgotten once it is idle. */
export class KeyedQueue<K> {
  private readonly lines = new Map<K, Promise<void>>()

  run<T>(key: K, operation: () => Promise<T>): Promise<T> {
    const next = (this.lines.get(key) ?? Promise.resolve()).then(operation)
    const settled = next.then(() => {}, () => {})
    this.lines.set(key, settled)
    void settled.then(() => { if (this.lines.get(key) === settled) this.lines.delete(key) })
    return next
  }
}
