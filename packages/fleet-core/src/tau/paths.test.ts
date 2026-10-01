import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathProblems, place, shareMount } from './paths.ts'

const share = (name: string, host: string) => ({ name, role: 'share' as const, host })
const problems = (paths: Parameters<typeof pathProblems>[0], sessionFolder = '/session') => pathProblems(paths, sessionFolder, '/dsh')

test('in and out paths are placed under /tau by role and name, keeping the caller\'s base name; a share path stays where the caller has it', () => {
  assert.equal(place({ name: 'rules', type: 'file', role: 'in', host: '/home/u/style.md' }), '/tau/in/rules/style.md')
  assert.equal(place({ name: 'site', type: 'dir', role: 'in', host: '/home/u/site' }), '/tau/in/site/site')
  assert.equal(place({ name: 'report', type: 'file', role: 'out', host: '/home/u/out/report.md' }), '/tau/out/report/report.md')
  assert.equal(place({ name: 'src', type: 'dir', role: 'share', host: '/home/u/src' }), '/home/u/src')
})

test('in and out paths may be in the session folder or the container\'s own folders, but an out path may not replace the session folder', () => {
  for (const host of ['/session/a.md', '/usr', '/tau/x', '/proc/x']) {
    for (const role of ['in', 'out'] as const) assert.deepEqual(problems([{ name: 'p', role, host }]), [], `${role} ${host}`)
  }
  assert.deepEqual(problems([{ name: 'p', role: 'in', host: '/session' }]), [])
  for (const host of ['/session', '/']) {
    assert.match(problems([{ name: 'p', role: 'out', host }])[0] ?? '', /is or holds the session folder|the dsh home/u, host)
  }
})

test('no path may be, hold or lie in the dsh home', () => {
  for (const role of ['in', 'out', 'share'] as const) {
    assert.deepEqual(problems([{ name: 'a', role, host: '/dsh' }, { name: 'b', role, host: '/' }, { name: 'c', role, host: '/dsh/fleet/x' }]), [
      'a: /dsh is the dsh home /dsh, where fleet keeps its sessions',
      'b: / holds the dsh home /dsh, where fleet keeps its sessions',
      'c: /dsh/fleet/x lies in the dsh home /dsh, where fleet keeps its sessions',
    ], role)
  }
})

test('a share path in the session folder is there already, unless it leads out; one that holds the folder is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-tau-paths-'))
  try {
    const session = join(dir, 'session')
    await mkdir(join(session, 'sub'), { recursive: true })
    await mkdir(join(dir, 'other'))
    await symlink(join(session, 'sub'), join(dir, 'link-into-session'))
    // Leads out of the session folder, but the container would resolve it among its own files.
    await symlink(join(dir, 'other'), join(session, 'link-out'))
    const found = problems([
      share('same', session), share('inside', join(session, 'sub')), share('holds', dir), share('linked', join(dir, 'link-into-session')),
      share('link-out', join(session, 'link-out')), share('fine', join(dir, 'other')),
    ], session)
    assert.deepEqual(found.map(problem => problem.split(':')[0]), ['holds', 'link-out'])
    assert.equal(shareMount({ host: session, view: session }, session), undefined)
    assert.equal(shareMount({ host: join(session, 'sub'), view: join(session, 'sub') }, session), undefined)
    // Mounted where it is given, which the session folder does not show.
    const linked = join(dir, 'link-into-session')
    assert.deepEqual(shareMount({ host: linked, view: linked }, session), { source: linked, target: linked, readonly: false })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a share path may not cover system or fleet folders, nor lie in the kernel\'s or fleet\'s', () => {
  const refused = ['/usr', '/etc', '/opt/fleet', '/tau', '/tau/in/x', '/run', '/proc/x', '/dev/shm', '/run/fleet/x']
  for (const host of refused) assert.equal(problems([share('p', host)]).length, 1, host)
  // A folder the container needs is the problem named, not the session folder it holds too.
  assert.match(problems([share('p', '/usr')], '/usr/src')[0] ?? '', /would cover \/usr in the container$/u)
  for (const host of ['/etc/app/config.json', '/work/rules.md', '/tmp/in', '/home/u/data', '/opt/data', '/opt/fleet-tau']) {
    assert.deepEqual(problems([share('p', host)]), [], host)
  }
})
