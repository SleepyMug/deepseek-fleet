import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathProblems } from './paths.ts'

const problems = (paths: Parameters<typeof pathProblems>[0]) => pathProblems(paths, '/dsh')

test('the caller\'s paths may be anywhere but the dsh home, the container\'s own folders included', () => {
  for (const host of ['/work/a.md', '/work', '/usr', '/tau/x', '/proc/x']) {
    for (const role of ['in', 'out'] as const) assert.deepEqual(problems([{ name: 'p', role, host }]), [], `${role} ${host}`)
  }
})

test('no path may be, hold or lie in the dsh home, where it really is, but for an out path\'s own name', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fleet-tau-paths-')))
  try {
    await mkdir(join(dir, 'home'))
    await symlink(join(dir, 'home'), join(dir, 'link'))
    const at = (role: 'in' | 'out') => pathProblems([{ name: 'p', role, host: join(dir, 'link') }], join(dir, 'home'))
    assert.deepEqual(at('in'), [`p: ${join(dir, 'link')} is the dsh home ${join(dir, 'home')}, where fleet keeps its sessions`])
    // Publishing it replaces the symlink, not what it leads to.
    assert.deepEqual(at('out'), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  for (const role of ['in', 'out'] as const) {
    const at = (name: string, host: string) => ({ name, role, host })
    assert.deepEqual(problems([at('a', '/dsh'), at('b', '/'), at('c', '/dsh/fleet/x')]), [
      'a: /dsh is the dsh home /dsh, where fleet keeps its sessions',
      'b: / holds the dsh home /dsh, where fleet keeps its sessions',
      'c: /dsh/fleet/x lies in the dsh home /dsh, where fleet keeps its sessions',
    ], role)
  }
})
