import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { snapshot } from './inputs.ts'

async function withDir(check: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-inputs-'))
  try {
    await check(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a folder is copied with its symlinks as links, through a link to it, and its modes', async () => {
  await withDir(async (dir) => {
    const source = join(dir, 'source')
    await mkdir(join(source, 'sub'), { recursive: true })
    await writeFile(join(source, 'sub', 'a.txt'), 'a')
    await writeFile(join(source, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
    await symlink('sub/a.txt', join(source, 'relative'))
    await symlink('/nowhere', join(source, 'dangling'))
    await symlink(join(dir, 'secret'), join(source, 'outside'))
    await writeFile(join(dir, 'secret'), 'not copied')
    await symlink(source, join(dir, 'link'))
    // A folder the caller cannot write to, whose copy the store must still be able to remove.
    await chmod(join(source, 'sub'), 0o555)

    assert.deepEqual(await snapshot('src', join(dir, 'link'), join(dir, 'copy')), [])
    assert.equal(await readFile(join(dir, 'copy', 'sub', 'a.txt'), 'utf8'), 'a')
    assert.equal(await readlink(join(dir, 'copy', 'relative')), 'sub/a.txt')
    assert.equal(await readlink(join(dir, 'copy', 'dangling')), '/nowhere')
    assert.ok((await lstat(join(dir, 'copy', 'outside'))).isSymbolicLink())
    assert.equal((await stat(join(dir, 'copy', 'run.sh'))).mode & 0o777, 0o755)
    assert.equal((await stat(join(dir, 'copy', 'sub'))).mode & 0o777, 0o755)
    await rm(join(dir, 'copy'), { recursive: true })
    await chmod(join(source, 'sub'), 0o755)
  })
})

test('a file is copied, a path that is gone is a problem, and a command that has gone stops the copy', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'rules.md'), 'be kind')
    assert.deepEqual(await snapshot('rules', join(dir, 'rules.md'), join(dir, 'copy.md')), [])
    assert.equal(await readFile(join(dir, 'copy.md'), 'utf8'), 'be kind')
    const [missing] = await snapshot('rules', join(dir, 'gone.md'), join(dir, 'other.md'))
    assert.match(missing!, /^rules: could not copy .*gone\.md: ENOENT/u)
    await assert.rejects(snapshot('rules', join(dir, 'rules.md'), join(dir, 'aborted.md'), AbortSignal.abort()), { name: 'AbortError' })
  })
})
