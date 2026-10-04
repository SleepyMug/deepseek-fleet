import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Type } from '@sleepymug/tau'
import { parseValues, UsageError } from './values.ts'

const PARAMS: { [name: string]: Type } = {
  style: { type: 'text' },
  notes: { type: 'file', mode: 'in' },
  site: { type: 'dir', mode: 'inout' },
  report: { type: 'path', mode: 'out' },
  edits: { type: 'list', of: { type: 'text' } },
}

test('name=value gives a text, or a handle of the mode the parameter declares', () => {
  assert.deepEqual(parseValues(['style=terse, but kind', 'notes=a.md', 'site=s', 'report=out/r.md', 'empty='], PARAMS), {
    style: 'terse, but kind', notes: { $in: 'a.md' }, site: { $inout: 's' }, report: { $out: 'out/r.md' }, empty: '',
  })
})

test('name:=json gives any value', () => {
  assert.deepEqual(parseValues(['edits:=["a","b"]', 'notes:={"$in":"b.md"}', 'style:="x=y"'], PARAMS), {
    edits: ['a', 'b'], notes: { $in: 'b.md' }, style: 'x=y',
  })
})

test('a name the tau does not declare passes as a text, even one an object has', () => {
  assert.deepEqual(parseValues(['other=x', 'toString=y'], PARAMS), { other: 'x', toString: 'y' })
})

test('a mistaken argument is a usage error', () => {
  for (const [args, message] of [
    [['style'], /style is neither/u],
    [['1x=a'], /1x=a is neither/u],
    [['style=a', 'style:="b"'], /style is given twice/u],
    [['edits:=[a]'], /the value of edits is not JSON/u],
  ] as const) {
    assert.throws(() => parseValues(args, PARAMS), (error: unknown) => error instanceof UsageError && message.test(error.message))
  }
})
