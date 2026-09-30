import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { copyProblems, outputProblems, replace } from './outputs.ts'

async function withDir(check: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-outputs-'))
  try {
    await check(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('plain files and folders pass, and a missing copy is left to tau\'s check', async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, 'out', 'nested'), { recursive: true })
    await writeFile(join(dir, 'out', 'nested', 'a.txt'), 'a')
    assert.deepEqual(await copyProblems(join(dir, 'out'), 'report', '/v/out'), [])
    assert.deepEqual(await copyProblems(join(dir, 'missing'), 'report', '/v/missing'), [])
  })
})

test('symlinks, hard links and oversized copies are refused', async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, 'out'))
    await symlink('/etc/passwd', join(dir, 'out', 'passwd'))
    await writeFile(join(dir, 'out', 'big'), 'x'.repeat(100))
    await link(join(dir, 'out', 'big'), join(dir, 'twin'))
    const problems = await copyProblems(join(dir, 'out'), 'report', '/v/out', 10)
    assert.deepEqual(problems, [
      'report: /v/out/big is a hard link, which fleet does not copy out',
      'report: /v/out/passwd is a symlink, which fleet does not copy out',
    ])
    await rm(join(dir, 'twin'))
    await rm(join(dir, 'out', 'passwd'))
    assert.match((await copyProblems(join(dir, 'out'), 'report', '/v/out', 10))[0]!, /100 bytes, over the 10-byte limit/u)
  })
})

test('a copy replaces a file at once, and a folder whole, leaving nothing beside it', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'copy.txt'), 'new')
    await writeFile(join(dir, 'report.txt'), 'old')
    await replace(join(dir, 'report.txt'), join(dir, 'copy.txt'))
    assert.equal(await readFile(join(dir, 'report.txt'), 'utf8'), 'new')
    await mkdir(join(dir, 'copy'))
    await writeFile(join(dir, 'copy', 'fresh'), '1')
    await mkdir(join(dir, 'site'))
    await writeFile(join(dir, 'site', 'stale'), '0')
    await replace(join(dir, 'site'), join(dir, 'copy'))
    assert.deepEqual(await readdir(join(dir, 'site')), ['fresh'])
    await replace(join(dir, 'created'), join(dir, 'copy.txt'))
    assert.deepEqual((await readdir(dir)).sort(), ['copy', 'copy.txt', 'created', 'report.txt', 'site'])
  })
})

test('outputs are checked as tau checks them: each out and inout path of the declared type', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'copy.md'), 'x')
    await mkdir(join(dir, 'data'))
    const paths = [
      { name: 'report', type: 'file' as const, role: 'out' as const, host: '/h/report.md' },
      { name: 'data', type: 'dir' as const, role: 'inout' as const, host: join(dir, 'data') },
      { name: 'rules', type: 'file' as const, role: 'inout' as const, host: join(dir, 'rules') },
      { name: 'in', type: 'file' as const, role: 'in' as const, host: '/missing' },
    ]
    const at = (copy: string) => () => join(dir, copy)
    await writeFile(join(dir, 'rules'), 'x')
    assert.deepEqual(await outputProblems(paths, at('copy.md')), [])
    assert.deepEqual(await outputProblems(paths, at('data')), ['report: /h/report.md is not a file'])
    // A pipe is not a file, though it is no folder either.
    await rm(join(dir, 'rules'))
    execFileSync('mkfifo', [join(dir, 'rules')])
    await rm(join(dir, 'data'), { recursive: true })
    assert.deepEqual(await outputProblems(paths, at('missing')), [
      'report: the agent left nothing at /h/report.md', `data: ${join(dir, 'data')} is gone`, `rules: ${join(dir, 'rules')} is not a file`,
    ])
  })
})
