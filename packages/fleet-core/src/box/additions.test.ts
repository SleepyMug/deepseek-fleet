import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { additionArgs, additionsFile, readAdditions, readCopied, removeAdditions, writeAdditions, writeCopied } from './additions.ts'

test('no additions add no arguments, so a container keeps its spec', () => {
  assert.deepEqual(additionArgs(undefined, '/work'), [])
  assert.deepEqual(additionArgs({ mounts: [] }, '/work'), [])
})

test('mounts become bind mounts, read-only when asked', () => {
  const args = additionArgs({
    mounts: [
      { source: '/home/u/.dsh/fleet/sessions/s/agent', target: '/tau/agent', readonly: true },
      { source: '/data,x', target: '/data', readonly: false },
    ],
  }, '/work')
  assert.deepEqual(args, [
    '--mount', 'type=bind,src=/home/u/.dsh/fleet/sessions/s/agent,dst=/tau/agent,readonly',
    '--mount', 'type=bind,"src=/data,x",dst=/data',
  ])
})

test('folders to make are not docker run arguments, so they leave a container\'s spec alone', () => {
  assert.deepEqual(additionArgs({ mounts: [], directories: ['/home/u/out'] }, '/work'), [])
})

test('variables are passed in name order, and none adds nothing', () => {
  assert.deepEqual(additionArgs({ mounts: [], env: { TZ: 'UTC', LANG: 'C.UTF-8' } }, '/work'), [
    '--env', 'LANG=C.UTF-8', '--env', 'TZ=UTC',
  ])
  assert.deepEqual(additionArgs({ mounts: [], env: {} }, '/work'), [])
})

test('a mount may not cover the workspace dir or fleet-box\'s own folders', () => {
  for (const target of ['/work', '/work/sub', '/', '/opt', '/opt/fleet', '/opt/fleet/bin', '/run', '/run/fleet']) {
    assert.throws(() => additionArgs({ mounts: [{ source: '/src', target, readonly: true }] }, '/work'), /overlaps/u, target)
  }
  assert.doesNotThrow(() => additionArgs({ mounts: [{ source: '/src', target: '/workshop', readonly: true }] }, '/work'))
})

test('a writable mount at its host path composes with the workspace dir\'s and others like it, left out where they show it already', () => {
  const at = (path: string, readonly = false) => ({ source: path, target: path, readonly })
  assert.deepEqual(additionArgs({ mounts: [at('/data/x'), at('/work'), at('/data'), at('/home'), at('/data'), at('/work/sub')] }, '/home/u/work'), [
    '--mount', 'type=bind,src=/work,dst=/work', '--mount', 'type=bind,src=/data,dst=/data', '--mount', 'type=bind,src=/home,dst=/home',
  ])
  // The workspace dir's own mount shows what lies in it, a file included, which mounted on its own could not be renamed over.
  assert.deepEqual(additionArgs({ mounts: [at('/work'), at('/work/sub'), at('/work/notes.md')] }, '/work'), [])
  // Read-only, or from elsewhere, it would hide the workspace dir's files, or another mount's.
  assert.throws(() => additionArgs({ mounts: [at('/work/sub', true)] }, '/work'), /overlaps \/work$/u)
  assert.throws(() => additionArgs({ mounts: [{ source: '/elsewhere', target: '/work/sub', readonly: false }] }, '/work'), /overlaps \/work$/u)
  assert.throws(() => additionArgs({ mounts: [at('/data'), at('/data/x', true)] }, '/work'), /mounts \/data\/x, which overlaps \/data$/u)
  assert.throws(() => additionArgs({ mounts: [at('/data'), { source: '/elsewhere', target: '/data', readonly: false }] }, '/work'), /overlaps \/data$/u)
  // fleet-box's own folders stay its own.
  assert.throws(() => additionArgs({ mounts: [at('/opt')] }, '/work'), /overlaps \/opt\/fleet$/u)
})

test('copies are not docker run arguments, and may overlap no mount, copy, workspace dir or fleet-box folder', () => {
  const agent = { source: '/store/agent', target: '/tau/agent', readonly: true }
  assert.deepEqual(additionArgs({ mounts: [], copies: [{ source: '/store/in/rules', target: '/home/u/rules.md' }] }, '/work'), [])
  for (const target of ['/work/rules.md', '/opt/fleet/x', '/tau/agent/x', '/tau']) {
    assert.throws(() => additionArgs({ mounts: [agent], copies: [{ source: '/s', target }] }, '/work'), /copies to .*overlaps/u, target)
  }
  assert.throws(() => additionArgs({ mounts: [], copies: [{ source: '/a', target: '/data' }, { source: '/b', target: '/data/b' }] }, '/work'), /overlaps/u)
})

test('the container a session\'s copies went into is recorded, and removed with its additions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fleet-box-additions-'))
  try {
    await writeAdditions(home, 'session-1', { mounts: [], copies: [{ source: '/store/in/rules', target: '/home/u/rules.md' }] })
    assert.equal(await readCopied(home, 'session-1'), undefined)
    await writeCopied(home, 'session-1', 'abc123')
    assert.equal(await readCopied(home, 'session-1'), 'abc123')
    await removeAdditions(home, 'session-1')
    assert.equal(await readCopied(home, 'session-1'), undefined)
    assert.equal(await readAdditions(home, 'session-1'), undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('additions round-trip through their file, which only the owner can read', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fleet-box-additions-'))
  try {
    assert.equal(await readAdditions(home, 'session-1'), undefined)
    const additions = { mounts: [{ source: '/src', target: '/tau/agent', readonly: true }] }
    await writeAdditions(home, 'session-1', additions)
    assert.deepEqual(await readAdditions(home, 'session-1'), additions)
    assert.equal((await stat(additionsFile(home, 'session-1'))).mode & 0o777, 0o600)
    assert.match(await readFile(additionsFile(home, 'session-1'), 'utf8'), /\/tau\/agent/u)
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
    for (const name of ['FLEET_SOCKET', 'PATH', 'HOME', 'NODE_OPTIONS', 'LD_PRELOAD']) {
      await assert.rejects(writeAdditions(home, 'session-2', { mounts: [], env: { [name]: '/elsewhere' } }), /the container's own/u, name)
    }
    await assert.rejects(writeAdditions(home, 'session-2', { mounts: [], directories: ['relative/dir'] }))
    await assert.rejects(writeAdditions(home, 'session-2', { mounts: [], copies: [{ source: 'relative', target: '/x' }] }))
    await assert.rejects(writeAdditions(home, 'session-2', { mounts: [], copies: [{ source: '/s', target: '/' }] }))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
