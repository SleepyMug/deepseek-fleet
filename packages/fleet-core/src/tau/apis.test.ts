import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_API, sessionApis } from './apis.ts'
import { promptSpec } from './spec.ts'

test('a session started from an agent directory has the APIs its agent declares, typed by the agent\'s declarations', () => {
  const spec = { ...promptSpec('Count.'), agent: { name: 'count', source: '/a/count' }, apis: [{ name: 'notes', description: 'Notes.', backends: ['notes'] }] }
  assert.deepEqual(sessionApis(spec), [{ name: 'notes', description: 'Notes.', backends: ['notes'], types: '/tau/agent/api/notes.d.ts' }])
  assert.deepEqual(sessionApis({ ...spec, apis: [] }), [])
})

test('any other session, as the web UI starts or a prompt run, has fleet\'s tau API, typed by fleet\'s declarations', () => {
  for (const spec of [undefined, promptSpec('Fix the build.')]) {
    const [api, ...rest] = sessionApis(spec)
    assert.deepEqual(rest, [])
    assert.ok(api !== undefined)
    assert.equal(api.name, DEFAULT_API)
    assert.deepEqual(api.backends, ['tau'])
    assert.equal(api.types, '/opt/fleet/apis/tau/index.d.ts')
    assert.match(api.description ?? '', /^Runs other agents in the tau format/u)
  }
})
