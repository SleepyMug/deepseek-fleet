import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { additionArgs, additionsFile, readAdditions, readCopied, removeAdditions, writeAdditions, writeCopied } from './additions.ts'

test('no additions add no arguments, so a container keeps its spec', () => {
  assert.deepEqual(additionArgs(undefined), [])
  assert.deepEqual(additionArgs({}), [])
})

test('copies and folders to make are not docker run arguments, so they leave a container\'s spec alone', () => {
  const copies = [{ source: '/store/agent', target: '/tau/agent' }, { source: '/store/in/src', target: '/home/u/proj/src' }]
  assert.deepEqual(additionArgs({ copies, directories: ['/home/u/proj/out'] }), [])
})

test('variables are passed in name order, and none adds nothing', () => {
  assert.deepEqual(additionArgs({ env: { TZ: 'UTC', LANG: 'C.UTF-8' } }), ['--env', 'LANG=C.UTF-8', '--env', 'TZ=UTC'])
  assert.deepEqual(additionArgs({ env: {} }), [])
})

test('the container a session\'s copies went into is recorded, and removed with its additions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fleet-box-additions-'))
  try {
    await writeAdditions(home, 'session-1', { copies: [{ source: '/store/in/rules', target: '/home/u/rules.md' }] })
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
    const additions = { ownFolder: true, copies: [{ source: '/src', target: '/tau/agent' }] }
    await writeAdditions(home, 'session-1', additions)
    assert.deepEqual(await readAdditions(home, 'session-1'), additions)
    assert.equal((await stat(additionsFile(home, 'session-1'))).mode & 0o777, 0o600)
    assert.match(await readFile(additionsFile(home, 'session-1'), 'utf8'), /\/tau\/agent/u)
    // The mounts an older fleet-box made are dropped.
    await writeFile(additionsFile(home, 'session-1'), '{"mounts": [{"source": "/data", "target": "/data", "readonly": false}], "ownFolder": true}')
    assert.deepEqual(await readAdditions(home, 'session-1'), { ownFolder: true })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an unreadable or invalid file fails rather than dropping the additions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fleet-box-additions-'))
  try {
    await writeAdditions(home, 'session-1', {})
    await writeFile(additionsFile(home, 'session-1'), '{"copies": [{"source": "relative", "target": "/x"}]}')
    await assert.rejects(readAdditions(home, 'session-1'), /not valid/u)
    await writeFile(additionsFile(home, 'session-1'), 'not json')
    await assert.rejects(readAdditions(home, 'session-1'), /not valid/u)
    await assert.rejects(writeAdditions(home, 'session-2', { env: { 'NOT-A-NAME': 'x' } }))
    for (const name of ['FLEET_SOCKET', 'PATH', 'HOME', 'NODE_OPTIONS', 'LD_PRELOAD']) {
      await assert.rejects(writeAdditions(home, 'session-2', { env: { [name]: '/elsewhere' } }), /the container's own/u, name)
    }
    await assert.rejects(writeAdditions(home, 'session-2', { directories: ['relative/dir'] }))
    await assert.rejects(writeAdditions(home, 'session-2', { copies: [{ source: 'relative', target: '/x' }] }))
    await assert.rejects(writeAdditions(home, 'session-2', { copies: [{ source: '/s', target: '/' }] }))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
