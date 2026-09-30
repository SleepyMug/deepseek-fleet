import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathProblems } from './paths.ts'

const path = (name: string, host: string) => ({ name, host })

test('a path that is, holds or lies in the session folder is refused, through symlinks too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-paths-'))
  try {
    const session = join(dir, 'session')
    await mkdir(join(session, 'sub'), { recursive: true })
    await mkdir(join(dir, 'other'))
    await symlink(join(session, 'sub'), join(dir, 'link-into-session'))
    // Leads out of the session folder, but the container would mount it inside.
    await symlink(join(dir, 'other'), join(session, 'link-out'))
    const problems = pathProblems([
      path('same', session), path('inside', join(session, 'sub')), path('holds', dir), path('linked', join(dir, 'link-into-session')),
      path('link-out', join(session, 'link-out')), path('fine', join(dir, 'other')),
    ], session)
    assert.deepEqual(problems.map(problem => problem.split(':')[0]), ['same', 'inside', 'holds', 'linked', 'link-out'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a path may not cover system or fleet folders, nor lie in the kernel\'s or fleet\'s', () => {
  const refused = ['/', '/usr', '/etc', '/opt', '/opt/fleet-tau', '/opt/fleet-tau/ts/x', '/run', '/proc/x', '/dev/shm', '/run/fleet-box/x']
  for (const host of refused) assert.equal(pathProblems([path('p', host)], '/session').length, 1, host)
  for (const host of ['/etc/app/config.json', '/work/rules.md', '/tmp/in', '/home/u/data', '/opt/data']) assert.deepEqual(pathProblems([path('p', host)], '/session'), [], host)
})
