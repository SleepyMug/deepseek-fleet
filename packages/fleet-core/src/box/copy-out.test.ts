import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, readlink, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { copyOut } from './copy-out.ts'

/** A helper over an in-memory tree: a string is a file, or a symlink when it begins `-> `, an object a folder, `null` a symlink, `0` a device. */
type Tree = string | null | 0 | { [name: string]: Tree }

function helper(root: Tree) {
  const find = (path: string): Tree | undefined => {
    let node: Tree | undefined = root
    for (const part of path.split('/').filter(part => part !== '')) {
      node = typeof node === 'object' && node !== null ? node[part] : undefined
    }
    return node
  }
  const reads: number[] = []
  return {
    reads,
    request: (method: string, params: Record<string, unknown>, schema: { parse(value: unknown): unknown }) => {
      const path = String(method === 'fs.readRange' || method === 'fs.listDir' ? (params.target as { targetKey: string }).targetKey : params.path)
      const node = find(path)
      let value: unknown
      switch (method) {
        case 'fs.lstat':
          value = node === undefined ? null : { type: node === null || isLink(node) ? 'symlink' : node === 0 ? 'other' : typeof node === 'string' ? 'file' : 'directory' }
          break
        // Only an absolute symlink is followed, as far as it leads.
        case 'fs.resolve': value = { targetKey: isLink(node) && node.startsWith('-> /') ? node.slice(3) : path, displayPath: path }; break
        case 'copyOut.readlink': value = (node as string).slice(3); break
        // A script is executable, and anything else read-only.
        case 'copyOut.mode': value = typeof node === 'string' && node.startsWith('#!') ? 0o755 : typeof node === 'object' ? 0o555 : 0o444; break
        case 'fs.listDir': value = Object.keys(node as object).map(name => ({ name })); break
        case 'fs.readRange': {
          const { offset, length } = params as { offset: number; length: number }
          reads.push(offset)
          value = Buffer.from(node as string).subarray(offset, offset + length).toString('base64')
          break
        }
        default: throw new Error(method)
      }
      return Promise.resolve(schema.parse(value)) as never
    },
  }
}

function isLink(node: Tree | undefined): node is string {
  return typeof node === 'string' && node.startsWith('-> ')
}

async function withDir(check: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-box-copy-out-'))
  try {
    await check(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('files and folders are copied as the host\'s own; nothing there copies nothing', async () => {
  await withDir(async (dir) => {
    const container = helper({ out: { 'report.md': 'done', nested: { 'a.txt': 'a' } } })
    assert.equal(await copyOut(container, '/out', join(dir, 'copy'), { maxBytes: 1024 }), true)
    assert.equal(await readFile(join(dir, 'copy', 'report.md'), 'utf8'), 'done')
    assert.deepEqual(await readdir(join(dir, 'copy', 'nested')), ['a.txt'])
    assert.equal(await copyOut(container, '/out/report.md', join(dir, 'file'), { maxBytes: 1024 }), true)
    assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'done')
    assert.equal(await copyOut(container, '/missing', join(dir, 'none'), { maxBytes: 1024 }), false)
  })
})

test('a symlink, a device, or too many bytes refuse the copy', async () => {
  await withDir(async (dir) => {
    await assert.rejects(copyOut(helper({ out: { link: null } }), '/out', join(dir, 'a'), { maxBytes: 1024 }), /\/out\/link is a symlink/u)
    await assert.rejects(copyOut(helper({ out: { tty: 0 } }), '/out', join(dir, 'b'), { maxBytes: 1024 }), /neither a file nor a folder/u)
    await assert.rejects(copyOut(helper({ out: { big: 'x'.repeat(100) } }), '/out', join(dir, 'c'), { maxBytes: 10 }), /more than 10 bytes/u)
  })
})

test('keeping links, the path is followed, and each symlink in it is copied as the link it is', async () => {
  await withDir(async (dir) => {
    const container = helper({ agent: { 'PROMPT.md': 'hi', 'run.sh': '#!/bin/sh', api: '-> shared', shared: { 'a.d.ts': 'x' } }, link: '-> /agent' })
    assert.equal(await copyOut(container, '/link', join(dir, 'copy'), { links: true }), true)
    assert.equal(await readFile(join(dir, 'copy', 'PROMPT.md'), 'utf8'), 'hi')
    // Permission bits are kept, though the host's user can still read the files and change the folders.
    assert.equal((await stat(join(dir, 'copy', 'run.sh'))).mode & 0o777, 0o755)
    assert.equal((await stat(join(dir, 'copy', 'PROMPT.md'))).mode & 0o777, 0o644)
    assert.equal((await stat(join(dir, 'copy', 'shared'))).mode & 0o777, 0o755)
    assert.equal(await readlink(join(dir, 'copy', 'api')), 'shared')
    assert.equal(await readFile(join(dir, 'copy', 'shared', 'a.d.ts'), 'utf8'), 'x')
    assert.equal(await copyOut(container, '/missing', join(dir, 'none'), { links: true }), false)
    await assert.rejects(copyOut(helper({ out: { tty: 0 } }), '/out', join(dir, 'device'), { links: true }), /neither a file nor a folder/u)
  })
})
