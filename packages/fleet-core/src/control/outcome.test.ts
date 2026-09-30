import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { lastTurnStart, openTurnStart, summarize } from './outcome.ts'

/** Just the fields the outcome reads. */
const start = { type: 'turn/start', data: {} }
const user = { type: 'user/message', data: {} }
const say = (text: string) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text }] } } })
const end = (reason: object) => ({ type: 'turn/end', data: { reason } })
const log = (...events: object[]): SessionEvent[] => events as unknown as SessionEvent[]

test('a run reports its last text and its last turn\'s end', () => {
  const events = log(user, start, say('first'), say(''), end({ kind: 'completed' }), start, say('second'), end({ kind: 'aborted' }))
  assert.deepEqual(summarize(events, 0), { reason: 'aborted', text: 'second' })
  assert.deepEqual(summarize(events, lastTurnStart(events)), { reason: 'aborted', text: 'second' })
})

test('an error turn carries its failure', () => {
  const events = log(start, end({ kind: 'error', error: { code: 'LLM_RATE_LIMIT', message: 'slow down' } }))
  assert.deepEqual(summarize(events, 0), { reason: 'error', text: '', error: { code: 'LLM_RATE_LIMIT', message: 'slow down' } })
})

test('a log without a finished turn has no reason', () => {
  assert.deepEqual(summarize(log(user), 0), { reason: null, text: '' })
  assert.deepEqual(summarize(log(user, start, say('working')), 0), { reason: null, text: 'working' })
})

test('steering joins the open turn, so its outcome counts from that turn\'s start', () => {
  const running = log(start, end({ kind: 'completed' }), user, start, say('busy'))
  assert.equal(openTurnStart(running), 3)
  const finished = log(...running as unknown as object[], user, say('STEERED'), end({ kind: 'completed' }))
  assert.deepEqual(summarize(finished, openTurnStart(running)), { reason: 'completed', text: 'STEERED' })
})

test('with no open turn, a message\'s outcome starts after the log', () => {
  const idle = log(start, end({ kind: 'completed' }))
  assert.equal(openTurnStart(idle), 2)
  assert.equal(openTurnStart(log()), 0)
})
