/**
 * What the fleet host takes of the process it runs in, so that each part is
 * given it, and a test gives its own: where it says what it does, the time,
 * new ids, and timers.
 * @module @sleepymug/fleet/platform
 */

import { randomBytes } from 'node:crypto'

export interface Platform {
  /** Say what was done, or what went wrong, to whoever runs the fleet host. */
  log(message: string): void
  now(): Date
  /** A new id: 16 hex digits. */
  newId(): string
  /**
   * Run `callback` after `ms`, without keeping the process alive for it.
   * @returns what cancels it.
   */
  after(ms: number, callback: () => void): () => void
}

/** The process's own, saying what is done with `log`, on stderr by default. */
export function systemPlatform(log: (message: string) => void = print): Platform {
  return {
    log,
    now: () => new Date(),
    newId: () => randomBytes(8).toString('hex'),
    after(ms, callback) {
      const timer = setTimeout(callback, ms)
      timer.unref()
      return () => { clearTimeout(timer) }
    },
  }
}

export function print(message: string): void {
  process.stderr.write(`fleet: ${message}\n`)
}
