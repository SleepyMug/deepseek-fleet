/**
 * A session's outcome, read from its log as dsh's headless runner reads a
 * run: the last non-empty assistant text and the last turn's end.
 * @module fleet-control/outcome
 */

import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { Outcome } from './protocol.ts'

/** The outcome of the turns that start from `from` on. */
export function summarize(events: readonly SessionEvent[], from: number): Outcome {
  let started = false
  let text = ''
  let reason: TurnEndReason | undefined
  for (const event of events.slice(from)) {
    if (event.type === 'turn/start') started = true
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content.map(block => block.type === 'text' ? block.text : '').join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  if (reason === undefined) return { reason: null, text }
  if (reason.kind !== 'error') return { reason: reason.kind, text }
  return { reason: reason.kind, text, error: { code: reason.error.code, message: reason.error.message } }
}

/** Where the log's last turn starts; past its end when it has none. */
export function lastTurnStart(events: readonly SessionEvent[]): number {
  const index = events.findLastIndex(event => event.type === 'turn/start')
  return index === -1 ? events.length : index
}

/** Where a turn still open at the end of the log starts; past the end when none is open. */
export function openTurnStart(events: readonly SessionEvent[]): number {
  const start = lastTurnStart(events)
  return events.slice(start).some(event => event.type === 'turn/end') ? events.length : start
}
