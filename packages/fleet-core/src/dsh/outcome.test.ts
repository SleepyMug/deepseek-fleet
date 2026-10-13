import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resultOf, summarize, type LoggedEvent, type TurnEnd } from './outcome.ts'

/** What dsh logs of a turn: its start, the agent's messages, and its end. */
function turn(turn: number, texts: string[], reason: { kind: string; error?: { message: string } }): LoggedEvent[] {
  return [
    { type: 'turn/start', data: { turn } },
    { type: 'user/message', data: {} },
    ...texts.map(text => ({ type: 'assistant/message', data: { message: { content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text }] } } })),
    { type: 'turn/end', data: { turn, reason } },
  ]
}

test('a run\'s outcome is its last turn\'s end and the last text its agent wrote', () => {
  const events = [...turn(1, ['Reading.', 'Done.', ''], { kind: 'completed' }), ...turn(2, [], { kind: 'aborted' })]
  assert.deepEqual(summarize(events), { end: { kind: 'aborted' }, text: 'Done.' })
  assert.deepEqual(summarize([{ type: 'turn/start', data: { turn: 1 } }]), { end: undefined, text: '' })
})

test('a run succeeds if its last turn completed, and says why it failed otherwise', () => {
  assert.deepEqual(resultOf({ end: { kind: 'completed' }, text: 'Done.' }), { ok: true, text: 'Done.' })
  const failures: [unknown, string][] = [
    [undefined, 'the run ended before its agent finished a turn'],
    [{ kind: 'aborted', reason: { kind: 'user' } }, 'the run was cancelled'],
    [{ kind: 'aborted', reason: { kind: 'disposed' } }, 'the fleet host stopped during the run'],
    [{ kind: 'aborted', reason: { kind: 'hook', reason: 'over budget' } }, 'a hook cancelled the run: over budget'],
    [{ kind: 'interrupted' }, 'the fleet host stopped during the run'],
    [{ kind: 'error', error: { message: 'rate limited' } }, 'the run failed: rate limited'],
    [{ kind: 'max-tokens' }, 'the model reached its output limit'],
    [{ kind: 'blocked' }, 'the run\'s last turn ended blocked'],
  ]
  for (const [end, failure] of failures) {
    assert.deepEqual(resultOf({ end: end as TurnEnd | undefined, text: 'Half' }), { ok: false, text: 'Half', failure })
  }
})
