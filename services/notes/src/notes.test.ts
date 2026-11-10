import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Notebooks } from './notes.ts'
import { answer, BOX_PACKAGE } from './service.ts'

async function folder(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-notes-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('each box has a notebook of its own, found by tag, which persists', async (t) => {
  const notebooks = new Notebooks(join(await folder(t), 'notes'))
  const first = answer(notebooks, 'box-a', { op: 'add', text: 'milk', tags: ['shop'] }) as { id: number; written: string }
  answer(notebooks, 'box-a', { op: 'add', text: 'call mum', tags: [] })
  answer(notebooks, 'box-b', { op: 'add', text: 'eggs', tags: ['shop'] })
  assert.equal(first.id, 1)
  assert.ok(!Number.isNaN(Date.parse(first.written)))
  assert.deepEqual((answer(notebooks, 'box-a', { op: 'tag', tag: 'shop' }) as { text: string }[]).map(note => note.text), ['milk'])
  assert.deepEqual(answer(notebooks, 'box-c', { op: 'tag', tag: 'shop' }), [])
})

test('what the box sends is checked', async (t) => {
  const notebooks = new Notebooks(await folder(t))
  assert.throws(() => answer(notebooks, 'box-a', { op: 'add', text: 1 }), /add takes a text/u)
  assert.throws(() => answer(notebooks, 'box-a', { op: 'add', text: 'x', tags: 'shop' }), /add takes tags/u)
  assert.throws(() => answer(notebooks, 'box-a', { op: 'tag' }), /tag takes a tag/u)
  assert.throws(() => answer(notebooks, 'box-a', { op: 'drop' }), /no op drop/u)
  assert.throws(() => answer(notebooks, '../a', { op: 'tag', tag: 'x' }), /no notebook named/u)
})

test('the service\'s package is fleet-notes-box, with the notes command', async () => {
  const { readFile } = await import('node:fs/promises')
  const manifest = JSON.parse(await readFile(join(BOX_PACKAGE, 'package.json'), 'utf8')) as { name: string; bin: Record<string, string> }
  assert.deepEqual([manifest.name, manifest.bin], ['@sleepymug/fleet-notes-box', { notes: './lib/notes.js' }])
})
