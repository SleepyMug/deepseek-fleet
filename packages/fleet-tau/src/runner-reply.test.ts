import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRunnerReply } from './runner-reply.ts'

test('each kind of reply is read', () => {
  assert.deepEqual(parseRunnerReply('{"ok":true,"modules":[{"specifier":"@svc/notes","packageRoot":"/opt/fleet-tau/agent/modules/node_modules/@svc/notes"}]}'),
    { ok: true, modules: [{ specifier: '@svc/notes', packageRoot: '/opt/fleet-tau/agent/modules/node_modules/@svc/notes' }] })
  assert.deepEqual(parseRunnerReply('{"ok":true,"value":null,"stdout":"","stderr":"","durationMs":3}'), { ok: true, value: null, stdout: '', stderr: '', durationMs: 3 })
  assert.deepEqual(parseRunnerReply('{"ok":false,"error":{"name":"TypeCheckError","message":"bad"}}'), { ok: false, error: { name: 'TypeCheckError', message: 'bad' } })
})

test('anything else, as a replaced runner might write, is no reply', () => {
  for (const text of ['', 'null', '[]', 'not json', '{"ok":true}', '{"ok":true,"modules":"all"}', '{"ok":false,"error":"x"}']) {
    assert.equal(parseRunnerReply(text), undefined, text)
  }
})
