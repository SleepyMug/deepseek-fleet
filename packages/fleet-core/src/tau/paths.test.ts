import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathProblems, place, shareMount } from './paths.ts'

const share = (name: string, host: string, view = host) => ({ name, role: 'share' as const, host, view })
const problems = (paths: Parameters<typeof pathProblems>[0]) => pathProblems(paths, '/dsh')

test('in and out paths are placed under /tau by role and name, keeping the caller\'s base name', () => {
  assert.equal(place({ name: 'rules', type: 'file', role: 'in', host: '/home/u/style.md' }), '/tau/in/rules/style.md')
  assert.equal(place({ name: 'site', type: 'dir', role: 'in', host: '/home/u/site' }), '/tau/in/site/site')
  assert.equal(place({ name: 'report', type: 'file', role: 'out', host: '/home/u/out/report.md' }), '/tau/out/report/report.md')
})

test('a share path is placed at its real path, and mounted from there to there', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fleet-tau-paths-')))
  try {
    await mkdir(join(dir, 'src'))
    await symlink(join(dir, 'src'), join(dir, 'link'))
    const at = (host: string) => place({ name: 'src', type: 'dir', role: 'share', host })
    assert.equal(at(join(dir, 'src')), join(dir, 'src'))
    assert.equal(at(join(dir, 'link')), join(dir, 'src'))
    // One not made yet, which tau's input check reports, is placed in its folder's real path.
    assert.equal(at(join(dir, 'link', 'missing')), join(dir, 'src', 'missing'))
    assert.deepEqual(shareMount({ view: join(dir, 'src') }), { source: join(dir, 'src'), target: join(dir, 'src'), readonly: false })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('in and out paths may be anywhere but the dsh home, the container\'s own folders included', () => {
  for (const host of ['/work/a.md', '/work', '/usr', '/tau/x', '/proc/x']) {
    for (const role of ['in', 'out'] as const) assert.deepEqual(problems([{ name: 'p', role, host, view: '/tau/x/p' }]), [], `${role} ${host}`)
  }
})

test('no path may be, hold or lie in the dsh home, where it really is, but for an out path\'s own name', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fleet-tau-paths-')))
  try {
    await mkdir(join(dir, 'home'))
    await symlink(join(dir, 'home'), join(dir, 'link'))
    const at = (role: 'in' | 'out' | 'share') => pathProblems([{ name: 'p', role, host: join(dir, 'link'), view: join(dir, 'home') }], join(dir, 'home'))
    assert.deepEqual(at('in'), [`p: ${join(dir, 'link')} is the dsh home ${join(dir, 'home')}, where fleet keeps its sessions`])
    // Publishing it replaces the symlink, not what it leads to.
    assert.deepEqual(at('out'), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  for (const role of ['in', 'out', 'share'] as const) {
    const at = (name: string, host: string) => ({ name, role, host, view: host })
    assert.deepEqual(problems([at('a', '/dsh'), at('b', '/'), at('c', '/dsh/fleet/x')]), [
      'a: /dsh is the dsh home /dsh, where fleet keeps its sessions',
      'b: / holds the dsh home /dsh, where fleet keeps its sessions',
      'c: /dsh/fleet/x lies in the dsh home /dsh, where fleet keeps its sessions',
    ], role)
  }
})

test('a share path may not cover system or fleet folders, nor lie in the kernel\'s or fleet\'s, where it really is', () => {
  const refused = ['/usr', '/etc', '/opt/fleet', '/tau', '/tau/in/x', '/run', '/proc/x', '/dev/shm', '/run/fleet/x']
  for (const host of refused) assert.equal(problems([share('p', host)]).length, 1, host)
  assert.deepEqual(problems([share('p', '/home/u/system', '/usr')]), ['p: /home/u/system, which is /usr, would cover /usr in the container'])
  assert.deepEqual(problems([share('p', '/usr/local/link', '/home/u/data')]), [])
  for (const host of ['/etc/app/config.json', '/work/rules.md', '/tmp/in', '/home/u/data', '/opt/data', '/opt/fleet-tau']) {
    assert.deepEqual(problems([share('p', host)]), [], host)
  }
})
