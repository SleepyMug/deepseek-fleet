/**
 * How a run of a tau ended, read from its session's events as dsh logs them:
 * the end of its last turn, and the last text its agent wrote. The events'
 * types are written out here as far as they are read, so this module imports
 * nothing of dsh's.
 * @module @sleepymug/fleet-core/tau/outcome
 */

import type { Result } from '@sleepymug/fleet-protocol/tau'

/** An event of a session's log, as far as an outcome reads it. */
export type LoggedEvent =
  | { type: 'turn/end'; data: { reason: TurnEnd } }
  | { type: 'assistant/message'; data: { message: { content: readonly { type: string; text?: string }[] } } }
  | { type: string; data?: unknown }

/**
 * Why a turn ended, as dsh's `TurnEndReason` has it: for a cancelled one,
 * by whom, a person, a hook, or the host disposing of the agent as it stops.
 */
export type TurnEnd = { kind: string; error?: { message?: string }; reason?: { kind: string; reason?: string } }

/** How a run's session ended. */
export interface Outcome {
  /** Why its last turn ended, or undefined when none did. */
  end: TurnEnd | undefined
  /** The last text its agent wrote; empty when it wrote none. */
  text: string
}

/** A session's outcome, from its whole log, which a run's session has to itself. */
export function summarize(events: readonly LoggedEvent[]): Outcome {
  let end: TurnEnd | undefined
  let text = ''
  for (const event of events) {
    if (event.type === 'turn/end') end = (event as Extract<LoggedEvent, { type: 'turn/end' }>).data.reason
    if (event.type === 'assistant/message') {
      const { content } = (event as Extract<LoggedEvent, { type: 'assistant/message' }>).data.message
      const joined = content.map(block => block.type === 'text' ? block.text ?? '' : '').join('')
      if (joined !== '') text = joined
    }
  }
  return { end, text }
}

/** A run's result: it succeeded if its agent finished its last turn, and why not if it did not. */
export function resultOf({ end, text }: Outcome): Result {
  const failure = failureOf(end)
  return failure === undefined ? { ok: true, text } : { ok: false, text, failure }
}

function failureOf(end: TurnEnd | undefined): string | undefined {
  if (end === undefined) return 'the run ended before its agent finished a turn'
  switch (end.kind) {
    case 'completed':
      return undefined
    case 'aborted':
      if (end.reason?.kind === 'disposed') return 'the fleet host stopped during the run'
      if (end.reason?.kind === 'hook') return `a hook cancelled the run: ${end.reason.reason ?? 'no reason given'}`
      return 'the run was cancelled'
    case 'interrupted':
      return 'the fleet host stopped during the run'
    case 'error':
      return `the run failed: ${end.error?.message ?? 'no reason given'}`
    case 'max-tokens':
      return 'the model reached its output limit'
    default:
      return `the run's last turn ended ${end.kind}`
  }
}
