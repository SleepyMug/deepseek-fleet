import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { BoundPath } from '@sleepymug/tau'
import { pathProblems } from './paths.ts'

const path = (name: string, host: string, view = host): BoundPath => ({ name, kind: 'dir', mode: 'mount-ro', host, view })

test('a path that is, holds or lies in the session folder is refused, through symlinks too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-paths-'))
  try {
    const session = join(dir, 'session')
    await mkdir(join(session, 'sub'), { recursive: true })
    await mkdir(join(dir, 'other'))
    await symlink(join(session, 'sub'), join(dir, 'link-into-session'))
    const problems = pathProblems([
      path('same', session), path('inside', join(session, 'sub')), path('holds', dir), path('linked', join(dir, 'link-into-session')),
      path('at-inside', join(dir, 'other'), join(session, 'x')), path('fine', join(dir, 'other')),
    ], session)
    assert.deepEqual(problems.map(problem => problem.split(':')[0]), ['same', 'inside', 'holds', 'linked', 'at-inside'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a path may not cover system or fleet folders, nor lie in the kernel\'s or fleet\'s', () => {
  const at = (view: string): BoundPath => path('p', '/src/p', view)
  const refused = ['/', '/usr', '/etc', '/opt', '/opt/fleet', '/opt/fleet/ts/x', '/run', '/proc/x', '/dev/shm', '/run/fleet-box/x']
  for (const view of refused) assert.equal(pathProblems([at(view)], '/session').length, 1, view)
  for (const view of ['/etc/app/config.json', '/work/rules.md', '/tmp/in', '/home/u/data', '/opt/data']) assert.deepEqual(pathProblems([at(view)], '/session'), [], view)
})
