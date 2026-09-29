import assert from 'node:assert/strict'
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { copyIn } from './copy-in.ts'

/** A helper whose container is the folder `root`: each copy-in request done there as the helper does it. */
function helper(root: string) {
  const methods: string[] = []
  return {
    methods,
    request: async (method: string, params: Record<string, unknown>, schema: { parse(value: unknown): unknown }) => {
      methods.push(method)
      const path = join(root, String(params.path))
      const data = Buffer.from(String(params.data ?? ''), 'base64')
      switch (method) {
        case 'copyIn.begin':
          await rm(path, { recursive: true, force: true })
          await mkdir(dirname(path), { recursive: true })
          break
        case 'copyIn.dir': await mkdir(path); await chmod(path, params.mode as number); break
        case 'copyIn.file': await writeFile(path, data, { flag: 'wx' }); await chmod(path, params.mode as number); break
        case 'copyIn.append': await appendFile(path, data); break
        case 'copyIn.symlink': await symlink(String(params.link), path); break
        default: throw new Error(method)
      }
      return schema.parse(null) as never
    },
  }
}

async function withDir(check: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-box-copy-in-'))
  try {
    await check(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a folder is copied with its files, modes and symlinks, in place of what the container had', async () => {
  await withDir(async (dir) => {
    const source = join(dir, 'source')
    await mkdir(join(source, 'sub'), { recursive: true })
    await writeFile(join(source, 'sub', 'a.txt'), 'a')
    await writeFile(join(source, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
    await symlink('sub/a.txt', join(source, 'link'))
    const container = join(dir, 'container')
    await mkdir(join(container, 'home', 'u', 'data'), { recursive: true })
    await writeFile(join(container, 'home', 'u', 'data', 'stale'), 'old')

    await copyIn(helper(container), source, '/home/u/data')
    assert.equal(await readFile(join(container, 'home', 'u', 'data', 'sub', 'a.txt'), 'utf8'), 'a')
    assert.equal((await lstat(join(container, 'home', 'u', 'data', 'run.sh'))).mode & 0o777, 0o755)
    assert.equal(await readlink(join(container, 'home', 'u', 'data', 'link')), 'sub/a.txt')
    await assert.rejects(lstat(join(container, 'home', 'u', 'data', 'stale')))
  })
})

test('a file is sent in chunks, into a folder made for it', async () => {
  await withDir(async (dir) => {
    const big = Buffer.alloc(9 * 1024 * 1024, 7)
    await writeFile(join(dir, 'big.bin'), big)
    const container = helper(join(dir, 'container'))
    await copyIn(container, join(dir, 'big.bin'), '/tmp/in/big.bin')
    assert.deepEqual(await readFile(join(dir, 'container', 'tmp', 'in', 'big.bin')), big)
    assert.deepEqual(container.methods, ['copyIn.begin', 'copyIn.file', 'copyIn.append', 'copyIn.append'])
  })
})
