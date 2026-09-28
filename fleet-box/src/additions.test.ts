import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { additionArgs, additionsFile, readAdditions, writeAdditions } from './additions.ts'

test('no additions add no arguments, so a container keeps its spec', () => {
  assert.deepEqual(additionArgs(undefined, '/work'), [])
  assert.deepEqual(additionArgs({ mounts: [] }, '/work'), [])
})

test('mounts become bind mounts, read-only when asked', () => {
  const args = additionArgs({
    mounts: [
      { source: '/home/u/.dsh/fleet/sessions/s/agent', target: '/opt/fleet/agent', readonly: true },
      { source: '/data,x', target: '/data', readonly: false },
    ],
  }, '/work')
  assert.deepEqual(args, [
    '--mount', 'type=bind,src=/home/u/.dsh/fleet/sessions/s/agent,dst=/opt/fleet/agent,readonly',
    '--mount', 'type=bind,"src=/data,x",dst=/data',
  ])
})

test('variables are passed in name order, and none adds nothing', () => {
  assert.deepEqual(additionArgs({ mounts: [], env: { TZ: 'UTC', LANG: 'C.UTF-8' } }, '/work'), [
    '--env', 'LANG=C.UTF-8', '--env', 'TZ=UTC',
  ])
  assert.deepEqual(additionArgs({ mounts: [], env: {} }, '/work'), [])
})

test('a mount may not cover the session folder or fleet-box\'s own folders', () => {
  for (const target of ['/work', '/work/sub', '/', '/opt', '/opt/fleet-box', '/opt/fleet-box/bin', '/run', '/run/fleet-box']) {
    assert.throws(() => additionArgs({ mounts: [{ source: '/src', target, readonly: true }] }, '/work'), /overlaps/u, target)
  }
  assert.doesNotThrow(() => additionArgs({ mounts: [{ source: '/src', target: '/workshop', readonly: true }] }, '/work'))
})

test('additions round-trip through their file, which only the owner can read', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fleet-box-additions-'))
  try {
    assert.equal(await readAdditions(home, 'session-1'), undefined)
    const additions = { mounts: [{ source: '/src', target: '/opt/fleet/agent', readonly: true }] }
    await writeAdditions(home, 'session-1', additions)
    assert.deepEqual(await readAdditions(home, 'session-1'), additions)
    assert.equal((await stat(additionsFile(home, 'session-1'))).mode & 0o777, 0o600)
    assert.match(await readFile(additionsFile(home, 'session-1'), 'utf8'), /opt\/fleet\/agent/u)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an unreadable or invalid file fails rather than dropping the additions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fleet-box-additions-'))
  try {
    await writeAdditions(home, 'session-1', { mounts: [] })
    await writeFile(additionsFile(home, 'session-1'), '{"mounts": [{"source": "relative", "target": "/x", "readonly": true}]}')
    await assert.rejects(readAdditions(home, 'session-1'), /not valid/u)
    await writeFile(additionsFile(home, 'session-1'), 'not json')
    await assert.rejects(readAdditions(home, 'session-1'), /not valid/u)
    await assert.rejects(writeAdditions(home, 'session-2', { mounts: [{ source: '/s', target: 'relative', readonly: true }] }))
    await assert.rejects(writeAdditions(home, 'session-2', { mounts: [], env: { 'NOT-A-NAME': 'x' } }))
    await assert.rejects(writeAdditions(home, 'session-2', { mounts: [], env: { TAU_SOCKET: '/elsewhere' } }), /set by fleet-box/u)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
