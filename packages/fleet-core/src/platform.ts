/**
 * What fleet-core's runs and service take of the process they run in, so
 * that each is given it, and a test gives its own: where they say what they
 * do, the time, new ids, and timers.
 * @module @sleepymug/fleet-core/platform
 */

import { randomUUID } from 'node:crypto'

export interface Platform {
  /** Say what was done, or what went wrong, to whoever runs the fleet host. */
  log(message: string): void
  now(): Date
  /** A new UUID. */
  newId(): string
  /**
   * Run `callback` after `ms`, without keeping the process alive for it.
   * @returns what cancels it.
   */
  after(ms: number, callback: () => void): () => void
}

/** The process's own, saying what is done with `log`. */
export function systemPlatform(log: (message: string) => void = print): Platform {
  return {
    log,
    now: () => new Date(),
    newId: () => randomUUID(),
    after(ms, callback) {
      const timer = setTimeout(callback, ms)
      timer.unref()
      return () => { clearTimeout(timer) }
    },
  }
}

/** On dsh's stderr, beside its own `dsh:` lines: its logger shows no info. */
export function print(message: string): void {
  process.stderr.write(`fleet-tau: ${message}\n`)
}
