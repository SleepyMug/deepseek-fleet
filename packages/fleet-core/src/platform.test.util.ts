/**
 * A platform for tests: what is logged is kept, ids count up, and time
 * moves, and timers run, only as the test advances it.
 * @module @sleepymug/fleet-core/platform.test.util
 */

import type { Platform } from './platform.ts'

export interface ManualPlatform extends Platform {
  readonly logged: string[]
  /** Move time on by `ms`, running each timer that falls due on the way, in turn. */
  advance(ms: number): void
}

export function manualPlatform(): ManualPlatform {
  let now = 0
  let ids = 0
  const timers = new Set<{ at: number; callback: () => void }>()
  const logged: string[] = []
  return {
    logged,
    log: message => { logged.push(message) },
    now: () => new Date(now),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    after(ms, callback) {
      const timer = { at: now + ms, callback }
      timers.add(timer)
      return () => { timers.delete(timer) }
    },
    advance(ms) {
      const until = now + ms
      for (;;) {
        const due = [...timers].filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0]
        if (due === undefined) break
        timers.delete(due)
        now = due.at
        due.callback()
      }
      now = until
    },
  }
}
