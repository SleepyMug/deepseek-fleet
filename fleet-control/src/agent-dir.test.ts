import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requiredArgs, stripFrontmatter, substituteArgs } from './agent-dir.ts'

test('requiredArgs is the highest bare $N', () => {
  assert.equal(requiredArgs('greet $1 and $3, then $2'), 3)
  assert.equal(requiredArgs('all of them: $@ $ARGUMENTS'), 0)
})

test('defaults and slices are optional', () => {
  assert.equal(requiredArgs('$1 ${2:-nobody} ${@:2} ${@:3:1}'), 1)
})

test('positional and all-argument placeholders', () => {
  assert.equal(substituteArgs('hi $1, then $2; all: $@ / $ARGUMENTS', ['a b', 'c']), 'hi a b, then c; all: a b c / a b c')
  assert.equal(substituteArgs('missing: [$3]', ['a']), 'missing: []')
})

test('defaults apply to missing and empty arguments', () => {
  assert.equal(substituteArgs('${1:-x} ${2:-y} ${3:-z}', ['a', '']), 'a y z')
  assert.equal(substituteArgs('${@:-none}', []), 'none')
})

test('slices count from 1 and take an optional length', () => {
  const args = ['a', 'b', 'c', 'd']
  assert.equal(substituteArgs('${@:2}', args), 'b c d')
  assert.equal(substituteArgs('${@:2:2}', args), 'b c')
  assert.equal(substituteArgs('${@:0}', args), 'a b c d')
})

test('arguments are not substituted again', () => {
  assert.equal(substituteArgs('$1 $2', ['$2', 'x']), '$2 x')
})

test('frontmatter is dropped and the body trimmed', () => {
  assert.equal(stripFrontmatter('---\ndescription: shout\n---\n\nUse $1.\n'), 'Use $1.')
  assert.equal(stripFrontmatter('\uFEFFplain\r\ntext\n'), 'plain\ntext\n')
  assert.equal(stripFrontmatter('--- not closed\nbody'), '--- not closed\nbody')
})
