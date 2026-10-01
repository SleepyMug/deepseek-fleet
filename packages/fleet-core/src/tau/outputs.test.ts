import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { copyProblems, outputProblems, publishTargets, replace } from './outputs.ts'

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

test('a copy replaces a file, and a folder entry by entry, leaving nothing beside it', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'copy.txt'), 'new')
    await writeFile(join(dir, 'report.txt'), 'old')
    await replace(join(dir, 'report.txt'), join(dir, 'copy.txt'))
    assert.equal(await readFile(join(dir, 'report.txt'), 'utf8'), 'new')
    // In a folder made for it, as when an outer out path published before it left none.
    await replace(join(dir, 'created', 'in', 'report.txt'), join(dir, 'copy.txt'))
    assert.equal(await readFile(join(dir, 'created', 'in', 'report.txt'), 'utf8'), 'new')
    await mkdir(join(dir, 'copy', 'kept', 'deep'), { recursive: true })
    await writeFile(join(dir, 'copy', 'fresh'), '1')
    await writeFile(join(dir, 'copy', 'kept', 'deep', 'page'), 'new page')
    await mkdir(join(dir, 'copy', 'was-a-file'))
    await writeFile(join(dir, 'copy', 'was-a-folder'), 'now a file')
    await mkdir(join(dir, 'site', 'kept', 'deep'), { recursive: true })
    await writeFile(join(dir, 'site', 'stale'), '0')
    await writeFile(join(dir, 'site', 'kept', 'deep', 'page'), 'old page')
    await writeFile(join(dir, 'site', 'kept', 'gone'), 'x')
    await writeFile(join(dir, 'site', 'was-a-file'), 'x')
    await mkdir(join(dir, 'site', 'was-a-folder'))
    const folders = await Promise.all(['site', 'site/kept', 'site/kept/deep'].map(async folder => (await stat(join(dir, folder))).ino))
    await replace(join(dir, 'site'), join(dir, 'copy'))
    assert.deepEqual((await readdir(join(dir, 'site'))).sort(), ['fresh', 'kept', 'was-a-file', 'was-a-folder'])
    assert.deepEqual(await readdir(join(dir, 'site', 'kept')), ['deep'])
    assert.equal(await readFile(join(dir, 'site', 'kept', 'deep', 'page'), 'utf8'), 'new page')
    assert.ok((await stat(join(dir, 'site', 'was-a-file'))).isDirectory())
    assert.equal(await readFile(join(dir, 'site', 'was-a-folder'), 'utf8'), 'now a file')
    // A mount of a folder that stays a folder, such as the container's of the workspace dir, still shows it.
    assert.deepEqual(await Promise.all(['site', 'site/kept', 'site/kept/deep'].map(async folder => (await stat(join(dir, folder))).ino)), folders)
    // A folder over a file, and nothing beside what was replaced.
    await replace(join(dir, 'report.txt'), join(dir, 'copy'))
    assert.deepEqual(await readdir(join(dir, 'report.txt', 'kept')), ['deep'])
    assert.deepEqual((await readdir(dir)).sort(), ['copy', 'copy.txt', 'created', 'report.txt', 'site'])
  })
})

test('a copy that cannot be put in place leaves the caller\'s path as it was', async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, 'copy', 'locked'), { recursive: true })
    await writeFile(join(dir, 'copy', 'a'), 'new a')
    await writeFile(join(dir, 'copy', 'locked', 'b'), 'new b')
    await mkdir(join(dir, 'site', 'locked'), { recursive: true })
    await writeFile(join(dir, 'site', 'a'), 'old a')
    await writeFile(join(dir, 'site', 'locked', 'old'), 'old')
    // Nothing can be moved out of or into the locked folder.
    await chmod(join(dir, 'site', 'locked'), 0o500)
    try {
      await assert.rejects(replace(join(dir, 'site'), join(dir, 'copy')), { code: 'EACCES' })
    } finally {
      await chmod(join(dir, 'site', 'locked'), 0o700)
    }
    assert.equal(await readFile(join(dir, 'site', 'a'), 'utf8'), 'old a')
    assert.deepEqual(await readdir(join(dir, 'site', 'locked')), ['old'])
    assert.deepEqual((await readdir(dir)).sort(), ['copy', 'site'])
  })
})

test('out paths are published where they are before any is, outermost first, and in their order at the same path', async () => {
  await withDir(async (dir) => {
    await mkdir(join(dir, 'site'))
    await mkdir(join(dir, 'data'))
    await symlink(join(dir, 'site'), join(dir, 'l'))
    await symlink(join(dir, 'data'), join(dir, 'to-data'))
    const hosts = [join(dir, 'l', 'a', 'b'), join(dir, 'l', 'x'), join(dir, 'site'), join(dir, 'site', 'x'), join(dir, 'site', 'a')]
    assert.deepEqual((await publishTargets(hosts.map(host => ({ host })))).map(({ path, at }) => [path.host, at]), [
      [join(dir, 'site'), join(dir, 'site')],
      [join(dir, 'l', 'x'), join(dir, 'site', 'x')],
      [join(dir, 'site', 'x'), join(dir, 'site', 'x')],
      [join(dir, 'site', 'a'), join(dir, 'site', 'a')],
      [join(dir, 'l', 'a', 'b'), join(dir, 'l', 'a', 'b')],
    ])
    // An out path that is a symlink is replaced, not followed, and publishing it first does not move one through it.
    const linked = await publishTargets([{ host: join(dir, 'to-data') }, { host: join(dir, 'to-data', 'r.md') }])
    assert.deepEqual(linked.map(({ at }) => at), [join(dir, 'to-data'), join(dir, 'data', 'r.md')])
    await writeFile(join(dir, 'copy.md'), 'r')
    await replace(join(dir, 'to-data'), join(dir, 'copy.md'))
    assert.equal(await readFile(join(dir, 'to-data'), 'utf8'), 'r')
    assert.deepEqual(await readdir(join(dir, 'data')), [])
  })
})

test('outputs are checked as tau checks them: what the agent left at each out path\'s place, of the declared type', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'copy.md'), 'x')
    await mkdir(join(dir, 'data'))
    execFileSync('mkfifo', [join(dir, 'pipe')])
    const paths = [
      { name: 'report', type: 'file' as const, role: 'out' as const, host: '/h/report.md', view: '/w/report.md' },
      { name: 'data', type: 'dir' as const, role: 'out' as const, host: '/h/data', view: '/w/data' },
      { name: 'in', type: 'file' as const, role: 'in' as const, host: '/missing', view: '/w/in' },
    ]
    const at = (copies: Record<string, string>) => (path: { name: string }) => join(dir, copies[path.name] ?? 'missing')
    assert.deepEqual(await outputProblems(paths, at({ report: 'copy.md', data: 'data' })), [])
    // Named where the agent left it.
    assert.deepEqual(await outputProblems(paths, at({ report: 'data', data: 'data' })), ['report: /w/report.md is not a file'])
    // A pipe is not a file, though it is no folder either.
    assert.deepEqual(await outputProblems(paths, at({ report: 'pipe' })), [
      'report: /w/report.md is not a file', 'data: the agent left nothing at /w/data',
    ])
  })
})
