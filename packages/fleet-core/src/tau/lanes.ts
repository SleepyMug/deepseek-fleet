/**
 * The lanes of the taus' model calls, as fleet-tau-lanes' config caps them
 * (./lanes-plugin.ts): a call takes a lane before it reaches its provider,
 * and gives it back once its stream ends, so no more calls stream at once
 * than there are lanes; the others wait, first come, first served. It knows
 * nothing of dsh's.
 * @module @sleepymug/fleet-core/tau/lanes
 */

/** A call waiting for a lane. */
interface Waiting {
  admit(): void
}

export class Lanes {
  /** The calls that hold a lane, counted whether the lanes are capped or not, so a cap set later counts them. */
  private busy = 0
  private readonly waiting: Waiting[] = []
  private readonly capacity: () => number | undefined

  /**
   * @param capacity - how many lanes there are now, read each time a lane is taken or given back; none for as many as are asked for.
   */
  constructor(capacity: () => number | undefined) {
    this.capacity = capacity
  }

  /**
   * Wait for a lane, and take it.
   * @param signal - gives up the wait.
   * @returns what gives the lane back, once; or undefined, without a lane, if the wait was given up.
   */
  async take(signal?: AbortSignal): Promise<(() => void) | undefined> {
    if (signal?.aborted === true) return undefined
    const admitted = new Promise<boolean>((resolve) => {
      const waiting: Waiting = {
        admit: () => {
          signal?.removeEventListener('abort', leave)
          resolve(true)
        },
      }
      const leave = (): void => {
        const at = this.waiting.indexOf(waiting)
        if (at !== -1) this.waiting.splice(at, 1)
        resolve(false)
      }
      signal?.addEventListener('abort', leave, { once: true })
      this.waiting.push(waiting)
    })
    this.admit()
    if (!await admitted) return undefined
    let held = true
    return () => {
      if (!held) return
      held = false
      this.busy -= 1
      this.admit()
    }
  }

  /** How many calls hold a lane, and how many wait for one. */
  get load(): { busy: number; waiting: number } {
    return { busy: this.busy, waiting: this.waiting.length }
  }

  /** Let the calls waiting longest have the lanes free now. */
  private admit(): void {
    const capacity = this.capacity()
    while (this.waiting.length > 0 && (capacity === undefined || this.busy < capacity)) {
      this.busy += 1
      this.waiting.shift()?.admit()
    }
  }
}
