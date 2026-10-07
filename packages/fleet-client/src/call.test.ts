import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FileDeclaration } from '@sleepymug/tau'
import { parseCall, UsageError } from './call.ts'

const FILES: { [name: string]: FileDeclaration } = {
  notes: { kind: 'file', mode: 'in', description: 'Notes.' },
  site: { kind: 'dir', mode: 'inout', description: 'A site.' },
  report: { mode: 'out', description: 'A report.' },
}

test('name=value gives a file of the tau its path, and else an arg a string', () => {
  assert.deepEqual(parseCall(['style=terse, but kind', 'notes=a.md', 'site=s', 'report=out/r.md', 'empty=', 'start=${site}/index.html'], FILES), {
    files: { notes: 'a.md', site: 's', report: 'out/r.md' },
    args: { style: 'terse, but kind', empty: '', start: '${site}/index.html' },
  })
})

test('name:=json gives a file its path, or a list of paths, and an arg any JSON', () => {
  assert.deepEqual(parseCall(['edits:=[{"old":"a","new":"b"}]', 'notes:=["a.md","b.md"]', 'style:="x=y"', 'top:=3'], FILES), {
    files: { notes: ['a.md', 'b.md'] },
    args: { edits: [{ old: 'a', new: 'b' }], style: 'x=y', top: 3 },
  })
})

test('a name the tau does not declare as a file is an arg, even one an object has', () => {
  assert.deepEqual(parseCall(['other=x', 'toString=y'], FILES), { files: {}, args: { other: 'x', toString: 'y' } })
})

test('a mistaken argument is a usage error', () => {
  for (const [args, message] of [
    [['style'], /style is neither/u],
    [['1x=a'], /1x=a is neither/u],
    [['style=a', 'style:="b"'], /style is given twice/u],
    [['notes=a', 'notes:="b"'], /notes is given twice/u],
    [['edits:=[a]'], /the value of edits is not JSON/u],
  ] as const) {
    assert.throws(() => parseCall(args, FILES), (error: unknown) => error instanceof UsageError && message.test(error.message))
  }
})
