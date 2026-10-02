import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_API, sessionApis, sessionPackages } from './apis.ts'
import { promptSpec } from './spec.ts'

test('a session started from an agent directory has the APIs its agent declares, typed by the agent\'s declarations', () => {
  const spec = { ...promptSpec('Count.'), agent: { name: 'count', source: '/a/count' }, apis: [{ name: 'notes', description: 'Notes.', backends: ['notes'], exposed: true }] }
  assert.deepEqual(sessionApis(spec), [{ name: 'notes', description: 'Notes.', backends: ['notes'], exposed: true, types: '/tau/agent/api/notes.d.ts' }])
  assert.deepEqual(sessionApis({ ...spec, apis: [] }), [])
  assert.deepEqual(sessionPackages(spec), [])
})

test('the packages an agent exposes are in its snapshot, and an API only they use is still the session\'s', () => {
  const spec = {
    ...promptSpec('Count.'),
    agent: { name: 'count', source: '/a/count' },
    apis: [{ name: 'notes', backends: ['notes'], exposed: false }],
    packages: [{ specifier: '@kits/notes', description: 'Notes in fewer calls.' }, { specifier: 'words' }],
  }
  assert.deepEqual(sessionApis(spec), [{ name: 'notes', backends: ['notes'], exposed: false, types: '/tau/agent/api/notes.d.ts' }])
  assert.deepEqual(sessionPackages(spec), [
    { specifier: '@kits/notes', description: 'Notes in fewer calls.', root: '/tau/agent/node_modules/@kits/notes' },
    { specifier: 'words', root: '/tau/agent/node_modules/words' },
  ])
})

test('any other session, as the web UI starts or a prompt run, has fleet\'s tau API, typed by fleet\'s declarations', () => {
  for (const spec of [undefined, promptSpec('Fix the build.')]) {
    const [api, ...rest] = sessionApis(spec)
    assert.deepEqual(rest, [])
    assert.ok(api !== undefined)
    assert.equal(api.name, DEFAULT_API)
    assert.deepEqual(api.backends, ['tau'])
    assert.equal(api.exposed, true)
    assert.equal(api.types, '/opt/fleet/apis/tau/index.d.ts')
    assert.match(api.description ?? '', /^Runs other agents in the tau format/u)
    assert.deepEqual(sessionPackages(spec), [])
  }
})
