import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { test } from 'node:test'
import type { Mode } from '@sleepymug/tau/core'
import { clientOf, placer } from './layout.ts'

/** Place the files of one run, each `[name, mode, the caller's path]`. */
function places(files: [string, Mode, string][]): string[] {
  const place = placer()
  return files.map(([name, mode, host]) => place(name, { mode, base: basename(host) }))
}

test('each file goes in the folder of its mode, under its base name', () => {
  assert.deepEqual(places([['notes', 'in', '/a/notes.md'], ['site', 'inout', '/b/site'], ['report', 'out', '/c/out/report.md']]), [
    '/tau/in/notes.md', '/tau/workspace/site', '/tau/out/report.md',
  ])
})

test('a file whose base name is taken in its folder goes in a folder of its own there, named for the file', () => {
  assert.deepEqual(places([
    ['a', 'in', '/a/notes.md'], ['b', 'in', '/b/notes.md'], ['c', 'in', '/c/notes.md'],
    ['d', 'out', '/d/notes.md'],
    ['e', 'in', '/e/.env'], ['f', 'in', '/f/.env'],
  ]), [
    '/tau/in/notes.md', '/tau/in/b/notes.md', '/tau/in/c/notes.md',
    '/tau/out/notes.md',
    '/tau/in/.env', '/tau/in/f/.env',
  ])
})

test('a folder of its own takes no name another file has, nor does a later file take its name', () => {
  assert.deepEqual(places([['a', 'in', '/a/b'], ['b', 'in', '/b/b'], ['c', 'in', '/c/b'], ['d', 'in', '/d/c']]), [
    '/tau/in/b', '/tau/in/b-1/b', '/tau/in/c/b', '/tau/in/d/c',
  ])
})

test('each contract\'s client is in a folder by its name', () => {
  assert.equal(clientOf('@sleepymug/tau-api-notes'), '/tau/node_modules/.fleet/@sleepymug/tau-api-notes')
})
