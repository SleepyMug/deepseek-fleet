import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { EXT } from './plugin.ts'
import { Notebooks } from './notes.ts'

const signal = new AbortController().signal

async function folder(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-notes-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('each session has a notebook of its own, found by tag, which persists', async (t) => {
  const dir = await folder(t)
  const { methods } = new Notebooks(join(dir, 'notes'))
  const first = methods.addNote?.(['milk', ['shop']], { sessionId: 'a', signal }) as { id: number; written: string }
  methods.addNote?.(['call mum'], { sessionId: 'a', signal })
  methods.addNote?.(['eggs', ['shop']], { sessionId: 'b', signal })
  assert.equal(first.id, 1)
  assert.ok(!Number.isNaN(Date.parse(first.written)))
  assert.deepEqual((methods.byTag?.(['shop'], { sessionId: 'a', signal }) as { text: string }[]).map(note => note.text), ['milk'])
  assert.deepEqual(methods.byTag?.(['shop'], { sessionId: 'c', signal }), [])
  // Another server on the same folder, as after dsh restarts, finds them.
  const again = new Notebooks(join(dir, 'notes')).methods
  assert.deepEqual((again.byTag?.(['shop'], { sessionId: 'b', signal }) as { text: string }[]).map(note => note.text), ['eggs'])
  assert.equal((again.addNote?.(['bread'], { sessionId: 'a', signal }) as { id: number }).id, 3)
})

test('what the box sends is checked', async (t) => {
  const { methods } = new Notebooks(await folder(t))
  assert.throws(() => methods.addNote?.([1], { sessionId: 'a', signal }), /addNote takes a text/u)
  assert.throws(() => methods.addNote?.(['x', 'shop'], { sessionId: 'a', signal }), /addNote takes tags/u)
  assert.throws(() => methods.byTag?.([], { sessionId: 'a', signal }), /byTag takes a tag/u)
  assert.throws(() => methods.byTag?.(['x'], { sessionId: '../a', signal }), /no notebook for a session named/u)
})

test('the client implements the contract at the version this package depends on, and imports only its own files and fleet\'s client runtime', async () => {
  assert.equal(EXT.version, JSON.parse(await readFile(new URL('../node_modules/@sleepymug/tau-api-notes/package.json', import.meta.url), 'utf8')).version)
  const code = await readFile(join(EXT.client, 'index.js'), 'utf8')
  assert.deepEqual([...code.matchAll(/from ['"]([^'"]+)['"]/gu)].map(match => match[1]), ['@sleepymug/fleet-box-runtime/ext/client', './contract.js'])
})
