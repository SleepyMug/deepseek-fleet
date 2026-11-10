import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { manualPlatform } from '../platform.test.util.ts'
import { FakeFleet } from './fake-fleet.test.util.ts'
import { SessionBox } from './session-box.ts'

const SESSION = 'session-11111111-1111-4111-8111-111111111111'

/** A session's box on the fake fleet host; set up again, its box gone, by making another. */
async function make(t: { after(fn: () => Promise<void>): void }): Promise<{ box: SessionBox; fleet: FakeFleet; work: string; rebuilt: () => number }> {
  const work = await mkdtemp(join(tmpdir(), 'dsh-tau-session-box-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const fleet = new FakeFleet(work)
  const first = await fleet.create({})
  let rebuilds = 0
  const box = new SessionBox({
    sessionId: SESSION,
    box: first,
    fleet,
    platform: manualPlatform(),
    rebuild: async () => {
      rebuilds += 1
      const made = await fleet.create({})
      await fleet.box(made).start()
      return made
    },
  })
  t.after(async () => { box.close() })
  fleet.calls.length = 0
  return { box, fleet, work, rebuilt: () => rebuilds }
}

test('a box is held started, and occupied without starting it; one the fleet host says is gone is set up again, once', async (t) => {
  const { box, fleet, rebuilt } = await make(t)
  const first = box.box
  const held = await box.hold({ kind: 'file', id: 'a' })
  assert.equal(held?.box.id, first)
  assert.deepEqual(fleet.calls, ['start'])
  held?.release()
  const release = box.occupy({ kind: 'turn', id: 'agent' })
  release()
  release()
  assert.deepEqual(fleet.calls, ['start'])

  fleet.lose(first)
  const again = await box.hold({ kind: 'file', id: 'b' })
  assert.notEqual(again?.box.id, first)
  assert.equal(box.box, again?.box.id)
  assert.equal(rebuilt(), 1)
  await box.hold({ kind: 'file', id: 'c' })
  assert.equal(rebuilt(), 1)
})

test('waiting for a box to be started starts nothing, wakes once something starts it, and fails once the session is gone', async (t) => {
  const { box, fleet } = await make(t)
  const signal = new AbortController().signal
  let woke = false
  const waiting = box.whenStarted(signal).then((started) => {
    woke = true
    return started
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(woke, false)
  assert.equal(box.isStarted(), false)
  assert.deepEqual(fleet.calls, [])
  await box.start()
  assert.equal((await waiting).id, box.box)
  assert.equal(box.isStarted(), true)
  await fleet.box(box.box).stop()
  const aborted = new AbortController()
  const given = box.whenStarted(aborted.signal)
  aborted.abort(new Error('enough'))
  await assert.rejects(given, /enough/u)
  const gone = box.whenStarted(signal)
  await box.remove(async () => {})
  await assert.rejects(gone, /no tau session/u)
  assert.equal(await box.hold({ kind: 'file', id: 'late' }), undefined)
})

test('a host file is copied into a box once, before its next use, and again after a failure', async (t) => {
  const { box, fleet, work } = await make(t)
  await writeFile(join(work, 'notes.csv'), 'a,b\n')
  box.copyInOnce(join(work, 'notes.csv'), '/fleet/attachments/notes.csv')
  box.copyInOnce(join(work, 'notes.csv'), '/fleet/attachments/notes.csv')
  await box.hold({ kind: 'file', id: 'after' })
  assert.deepEqual(fleet.calls, [
    'start', 'exec mkdir -p /fleet/attachments', `copyIn ${join(work, 'notes.csv')} /fleet/attachments/notes.csv`, 'exec chmod a=r /fleet/attachments/notes.csv',
  ])
  fleet.failing = 'copyIn'
  box.copyInOnce(join(work, 'notes.csv'), '/fleet/attachments/other.csv')
  await box.hold({ kind: 'file', id: 'after' }).catch(() => {})
  fleet.failing = undefined
  fleet.calls.length = 0
  box.copyInOnce(join(work, 'notes.csv'), '/fleet/attachments/other.csv')
  await box.hold({ kind: 'file', id: 'again' })
  assert.deepEqual(fleet.calls.filter(call => call.startsWith('copyIn')), [`copyIn ${join(work, 'notes.csv')} /fleet/attachments/other.csv`])
})

test('an archived box is removed, and none is had until it is unarchived; then it is set up again', async (t) => {
  const { box, fleet, rebuilt } = await make(t)
  const first = box.box
  await box.archive()
  assert.equal(fleet.made.has(first), false)
  assert.equal(box.isArchived(), true)
  await assert.rejects(box.hold({ kind: 'file', id: 'a' }), /is archived/u)
  assert.equal(rebuilt(), 0)
  box.unarchive()
  const held = await box.hold({ kind: 'file', id: 'b' })
  assert.notEqual(held?.box.id, first)
  assert.equal(rebuilt(), 1)
  // A box removed by other means is let be as the session is forgotten.
  fleet.lose(box.box)
  let forgotten = false
  await box.remove(async () => { forgotten = true })
  assert.equal(forgotten, true)
})
