import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { test } from 'node:test'
import type { Kind, Mode } from '@sleepymug/tau'
import { placer } from './place.ts'

/** Place handles of one run, each `[mode, host path]`. */
function places(handles: [Mode, string][], kind: Kind = 'path'): string[] {
  const place = placer()
  return handles.map(([mode, host], index) => place({ at: `h${String(index)}`, pointer: `/h${String(index)}`, mode, kind, name: basename(host), host }))
}

test('each handle goes in the folder of its mode, under its base name', () => {
  assert.deepEqual(places([['in', '/a/notes.md'], ['inout', '/b/site'], ['out', '/c/out/report.md']]), [
    '/tau/in/notes.md', '/tau/workspace/site', '/tau/out/report.md',
  ])
})

test('a base name taken in its folder gets a suffix in its stem', () => {
  assert.deepEqual(places([
    ['in', '/a/notes.md'], ['in', '/b/notes.md'], ['in', '/c/notes.md'],
    ['out', '/d/notes.md'],
    ['in', '/e/.env'], ['in', '/f/.env'],
    ['in', '/g/site'], ['in', '/h/site'],
    ['in', '/i/archive.tar.gz'], ['in', '/j/archive.tar.gz'],
  ]), [
    '/tau/in/notes.md', '/tau/in/notes-1.md', '/tau/in/notes-2.md',
    '/tau/out/notes.md',
    '/tau/in/.env', '/tau/in/.env-1',
    '/tau/in/site', '/tau/in/site-1',
    '/tau/in/archive.tar.gz', '/tau/in/archive.tar-1.gz',
  ])
})

test('a suffixed name does not take a name the caller gives', () => {
  assert.deepEqual(places([['in', '/a/notes.md'], ['in', '/b/notes.md'], ['in', '/c/notes-1.md']]), [
    '/tau/in/notes.md', '/tau/in/notes-1.md', '/tau/in/notes-1-1.md',
  ])
})
