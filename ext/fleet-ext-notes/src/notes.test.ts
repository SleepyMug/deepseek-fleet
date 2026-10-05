import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadApis, checkImplementation } from '@sleepymug/tau'
import { CLIENT } from './plugin.ts'
import { Notebooks } from './notes.ts'

const signal = new AbortController().signal

test('each session has a notebook of its own, found by tag', () => {
  const { methods } = new Notebooks()
  const first = methods.addNote?.(['milk', ['shop']], { sessionId: 'a', signal }) as { id: number; written: string }
  methods.addNote?.(['call mum'], { sessionId: 'a', signal })
  methods.addNote?.(['eggs', ['shop']], { sessionId: 'b', signal })
  assert.equal(first.id, 1)
  assert.ok(!Number.isNaN(Date.parse(first.written)))
  assert.deepEqual((methods.byTag?.(['shop'], { sessionId: 'a', signal }) as { text: string }[]).map(note => note.text), ['milk'])
  assert.deepEqual(methods.byTag?.(['shop'], { sessionId: 'c', signal }), [])
})

test('what the box sends is checked', () => {
  const { methods } = new Notebooks()
  assert.throws(() => methods.addNote?.([1], { sessionId: 'a', signal }), /addNote takes a text/u)
  assert.throws(() => methods.addNote?.(['x', 'shop'], { sessionId: 'a', signal }), /addNote takes tags/u)
  assert.throws(() => methods.byTag?.([], { sessionId: 'a', signal }), /byTag takes a tag/u)
})

test('the client implements the notes API as the example tau declares it, and imports only fleet\'s client runtime', async () => {
  const [api] = loadApis(new URL('../../../examples/notebook/', import.meta.url).pathname)
  assert.equal(api?.name, 'notes')
  checkImplementation(api, join(CLIENT, 'index.js'))
  const code = await readFile(join(CLIENT, 'index.js'), 'utf8')
  assert.deepEqual([...code.matchAll(/from ['"]([^'"]+)['"]/gu)].map(match => match[1]), ['fleet-box-runtime/ext/client'])
})
