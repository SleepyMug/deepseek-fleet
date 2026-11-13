/**
 * Operations run one after another: each starts once the one before it
 * settled, whether it succeeded or failed.
 * @module @sleepymug/fleet/util/queue
 */

export class Queue {
  private last: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.last.then(operation)
    this.last = next.then(() => {}, () => {})
    return next
  }
}
