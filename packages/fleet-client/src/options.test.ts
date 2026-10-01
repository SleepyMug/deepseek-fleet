import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UsageError, parseOptions } from './options.ts'

const kinds = { '--async': 'flag', '--project': 'value', '-p': 'value' } as const

test('options come first, and the first other argument ends them', () => {
  const parsed = parseOptions(['--async', '--project', '/src', 'agent', '--async', 'x'], kinds)
  assert.deepEqual([...parsed.flags], ['--async'])
  assert.deepEqual([...parsed.values], [['--project', '/src']])
  assert.deepEqual(parsed.positional, ['agent', '--async', 'x'])
})

test('a value follows its option or its `=`, whatever it starts with', () => {
  assert.deepEqual([...parseOptions(['--project=/a=b'], kinds).values], [['--project', '/a=b']])
  assert.deepEqual([...parseOptions(['-p', '-v is verbose', '--async'], kinds).values], [['-p', '-v is verbose']])
  assert.deepEqual([...parseOptions(['-p', '-v is verbose', '--async'], kinds).flags], ['--async'])
})

test('`--` ends the options, and a lone `-` is an argument', () => {
  assert.deepEqual(parseOptions(['--', '--async'], kinds).positional, ['--async'])
  assert.deepEqual(parseOptions(['-', 'x'], kinds).positional, ['-', 'x'])
})

test('unknown options, missing values and valued flags are usage errors', () => {
  assert.throws(() => parseOptions(['--bogus'], kinds), UsageError)
  assert.throws(() => parseOptions(['--project'], kinds), UsageError)
  assert.throws(() => parseOptions(['--project='], kinds), UsageError)
  assert.throws(() => parseOptions(['--async=1'], kinds), UsageError)
})
