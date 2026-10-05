import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BoundHandle } from '@sleepymug/tau'
import { check, publish } from './outputs.ts'

/** A caller's folder, and a staging folder beside it. */
async function folders(t: { after(fn: () => Promise<void>): void }): Promise<{ caller: string; staging: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-outputs-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'caller'))
  await mkdir(join(dir, 'staging'))
  return { caller: join(dir, 'caller'), staging: join(dir, 'staging') }
}

function handle(at: string, mode: BoundHandle['mode'], kind: BoundHandle['kind'], host: string): BoundHandle {
  return { at, mode, kind, host, view: `/tau/${mode}/${at}` }
}

test('a folder merges into the caller\'s, entry by entry, and anything else replaces what is there', async (t) => {
  const { caller, staging } = await folders(t)
  await mkdir(join(caller, 'site', 'old'), { recursive: true })
  await writeFile(join(caller, 'site', 'kept.md'), 'kept\n')
  await writeFile(join(caller, 'site', 'index.md'), 'old\n')
  await writeFile(join(caller, 'site', 'old', 'x.md'), 'x\n')
  await writeFile(join(caller, 'outside.md'), 'not the run\'s\n')
  await symlink('../outside.md', join(caller, 'site', 'link.md'))
  // What the run left: index.md changed, old a file now, link.md a file of its own, a new folder, a mode kept, a relative link kept.
  await mkdir(join(staging, '0', 'new'), { recursive: true })
  await writeFile(join(staging, '0', 'index.md'), 'new\n')
  await writeFile(join(staging, '0', 'old'), 'a file now\n')
  await writeFile(join(staging, '0', 'link.md'), 'mine\n')
  await writeFile(join(staging, '0', 'new', 'run.sh'), '#!/bin/sh\n')
  await chmod(join(staging, '0', 'new', 'run.sh'), 0o750)
  await symlink('run.sh', join(staging, '0', 'new', 'latest'))
  await writeFile(join(staging, '1'), 'report\n')
  await writeFile(join(caller, 'report.md'), 'an old report\n')

  await publish([handle('site', 'inout', 'dir', join(caller, 'site')), handle('report', 'out', 'file', join(caller, 'report.md'))], staging)
  assert.deepEqual((await readdir(join(caller, 'site'))).sort(), ['index.md', 'kept.md', 'link.md', 'new', 'old'])
  assert.equal(await readFile(join(caller, 'site', 'index.md'), 'utf8'), 'new\n')
  assert.equal(await readFile(join(caller, 'site', 'old'), 'utf8'), 'a file now\n')
  // The caller's link was replaced, not followed.
  assert.ok((await lstat(join(caller, 'site', 'link.md'))).isFile())
  assert.equal(await readFile(join(caller, 'outside.md'), 'utf8'), 'not the run\'s\n')
  assert.equal((await lstat(join(caller, 'site', 'new', 'run.sh'))).mode & 0o777, 0o750)
  assert.equal(await readlink(join(caller, 'site', 'new', 'latest')), 'run.sh')
  assert.equal(await readFile(join(caller, 'report.md'), 'utf8'), 'report\n')
})

test('the caller\'s own path leads where its symlink does, and an inner path is put last', async (t) => {
  const { caller, staging } = await folders(t)
  await mkdir(join(caller, 'real'))
  await writeFile(join(caller, 'real', 'kept.md'), 'kept\n')
  await symlink('real', join(caller, 'pages'))
  // `pages/a.md` lies inside `pages`, and wins over what `pages` has there, whatever their order in the values.
  await writeFile(join(staging, '0'), 'from the inner handle\n')
  await mkdir(join(staging, '1'))
  await writeFile(join(staging, '1', 'a.md'), 'from the outer handle\n')

  await publish([handle('a', 'out', 'file', join(caller, 'pages', 'a.md')), handle('pages', 'out', 'dir', join(caller, 'pages'))], staging)
  assert.equal(await readlink(join(caller, 'pages')), 'real')
  assert.deepEqual((await readdir(join(caller, 'real'))).sort(), ['a.md', 'kept.md'])
  assert.equal(await readFile(join(caller, 'real', 'a.md'), 'utf8'), 'from the inner handle\n')
})

test('the check finds what a run did not leave as its tau declares', async (t) => {
  const { caller, staging } = await folders(t)
  const handles = [
    handle('notes', 'in', 'file', join(caller, 'notes.md')),
    handle('site', 'inout', 'dir', join(caller, 'site')),
    handle('report', 'out', 'file', join(caller, 'report.md')),
    handle('pages', 'out', 'dir', join(caller, 'pages')),
  ]
  await mkdir(join(staging, '1'))
  await writeFile(join(staging, '2'), 'report\n')
  await mkdir(join(staging, '3'))
  assert.equal(check(handles, staging), undefined)

  await rm(join(staging, '2'))
  await symlink('/etc/passwd', join(staging, '3', 'escape'))
  const problems = check(handles, staging) ?? ''
  assert.match(problems, /^the run did not leave what the tau declares:/u)
  assert.match(problems, /\n {2}report: \/tau\/out\/report does not exist/u)
  assert.doesNotMatch(problems, new RegExp(staging, 'u'))
  assert.match(problems, /\n {2}pages: /u)
  assert.doesNotMatch(problems, /notes|site/u)
})
