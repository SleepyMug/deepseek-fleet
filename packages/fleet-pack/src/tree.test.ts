import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { digestOf } from './digest.ts'
import { ArchiveError, readTar, writeTar } from './tar.ts'
import { bytesEntry, linkEntry, packTree, treeEntries, unpackTree } from './tree.ts'

async function folder(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-pack-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A tree with a file, an executable, a long name, a symlink and a folder of its own mode. */
async function sample(dir: string): Promise<void> {
  await mkdir(join(dir, 'bin'), { recursive: true })
  await writeFile(join(dir, 'README.md'), 'hello\n')
  await writeFile(join(dir, 'bin', 'run'), '#!/bin/sh\necho run\n')
  await chmod(join(dir, 'bin', 'run'), 0o755)
  const deep = join(dir, 'a'.repeat(60), 'b'.repeat(60))
  await mkdir(deep, { recursive: true })
  await writeFile(join(deep, 'c'.repeat(80)), Buffer.alloc(70_000, 7))
  await symlink('../README.md', join(dir, 'bin', 'readme'))
  await mkdir(join(dir, 'private'))
  await writeFile(join(dir, 'private', 'key'), 'k')
  await chmod(join(dir, 'private'), 0o700)
}

test('a tree packed and unpacked is the same tree, its digest the same', async (t) => {
  const dir = await folder(t)
  await sample(join(dir, 'from'))
  await unpackTree(packTree(join(dir, 'from')), join(dir, 'to'))
  assert.equal(await digestOf(join(dir, 'to')), await digestOf(join(dir, 'from')))
  assert.equal(await readlink(join(dir, 'to', 'bin', 'readme')), '../README.md')
  assert.equal((await lstat(join(dir, 'to', 'bin', 'run'))).mode & 0o777, 0o755)
  assert.equal((await lstat(join(dir, 'to', 'private'))).mode & 0o777, 0o700)
})

test('an archive is put together from several places, and unpacks over what a folder holds, keeping the rest', async (t) => {
  const dir = await folder(t)
  await sample(join(dir, 'pkg'))
  async function* composed() {
    yield* treeEntries(join(dir, 'pkg'), 'services/one')
    yield bytesEntry('README.md', '# the box\n')
    yield linkEntry('bin/run', '../services/one/bin/run')
  }
  await mkdir(join(dir, 'into'))
  await writeFile(join(dir, 'into', 'kept'), 'kept')
  await writeFile(join(dir, 'into', 'README.md'), 'old')
  await unpackTree(writeTar(composed()), join(dir, 'into'))
  assert.equal(await readFile(join(dir, 'into', 'kept'), 'utf8'), 'kept')
  assert.equal(await readFile(join(dir, 'into', 'README.md'), 'utf8'), '# the box\n')
  assert.equal(await readFile(join(dir, 'into', 'bin', 'run'), 'utf8'), '#!/bin/sh\necho run\n')
})

test('unpacking does not write through a symlink, unless told to follow them', async (t) => {
  const dir = await folder(t)
  await mkdir(join(dir, 'outside'))
  const archive = () => writeTar([linkEntry('escape', join(dir, 'outside')), bytesEntry('escape/file', 'x')])
  await assert.rejects(unpackTree(archive(), join(dir, 'into')), /symlink, which unpacking does not write through/u)
  await assert.rejects(readFile(join(dir, 'outside', 'file')))
  await unpackTree(archive(), join(dir, 'followed'), { followLinks: true })
  assert.equal(await readFile(join(dir, 'outside', 'file'), 'utf8'), 'x')
})

test('an archive with a name that leaves the folder, or that ends short, is refused', async (t) => {
  const dir = await folder(t)
  const bad = writeTar([{ name: '../x', type: 'file', mode: 0o644, size: 1, body: async function* () { yield Buffer.from('x') } }])
  await assert.rejects(unpackTree(bad, join(dir, 'into')), ArchiveError)
  const chunks: Uint8Array[] = []
  for await (const chunk of writeTar([bytesEntry('a', 'abc')])) chunks.push(chunk)
  const short = Buffer.concat(chunks).subarray(0, 600)
  await assert.rejects(async () => { for await (const _ of readTar(Readable.from([short]))) { /* read */ } }, ArchiveError)
})

test('GNU tar\'s archive of a folder reads as the folder', async (t) => {
  const dir = await folder(t)
  await sample(join(dir, 'from'))
  const { stdout } = await promisify(execFile)('tar', ['-c', '-C', join(dir, 'from'), '.'], { encoding: 'buffer', maxBuffer: Infinity })
  await unpackTree(Readable.from([stdout]), join(dir, 'to'))
  assert.equal(await digestOf(join(dir, 'to')), await digestOf(join(dir, 'from')))
})
