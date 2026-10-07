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

test('--in, --out and --inout give a file with its mode, an extra file or a declared one', () => {
  const moded = { in: ['guide=g.md', 'drafts:=["a.md","b.md"]'], out: ['best=out/best.md'], inout: ['site=s'] }
  assert.deepEqual(parseCall(['notes=a.md', 'start=$${guide}'], FILES, moded), {
    files: {
      notes: 'a.md',
      guide: { mode: 'in', path: 'g.md' },
      drafts: { mode: 'in', path: ['a.md', 'b.md'] },
      best: { mode: 'out', path: 'out/best.md' },
      site: { mode: 'inout', path: 's' },
    },
    args: { start: '$${guide}' },
  })
  assert.throws(() => parseCall(['guide=x'], FILES, { in: ['guide=g.md'] }), (error: unknown) => error instanceof UsageError && /guide is given twice/u.test(error.message))
  assert.throws(() => parseCall([], FILES, { out: ['best'] }), (error: unknown) => error instanceof UsageError && /--out best is neither --out <name>=<value>/u.test(error.message))
})
