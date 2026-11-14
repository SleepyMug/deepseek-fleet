import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { manualPlatform, type ManualPlatform } from '../platform.test.util.ts'
import { FakeFleet } from './fake-fleet.test.util.ts'
import { SessionBox } from './session-box.ts'

const SESSION = 'session-11111111-1111-4111-8111-111111111111'

/** A box's spec, as the runs make one. */
const SPEC = { labels: {}, env: {}, services: [] }

/** How long the test's boxes idle before they are stopped. */
const IDLE = 1000

/** Let what the box queued run. */
const settled = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** A session's box on the fake gateway, followed; set up again, its box gone, by making another. */
async function make(t: { after(fn: () => Promise<void>): void }): Promise<{ box: SessionBox; fleet: FakeFleet; platform: ManualPlatform; work: string; rebuilt: () => number }> {
  const work = await mkdtemp(join(tmpdir(), 'dsh-tau-session-box-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const fleet = new FakeFleet(work)
  const first = await fleet.create(SPEC)
  let rebuilds = 0
  const platform = manualPlatform()
  const box = new SessionBox({
    sessionId: SESSION,
    box: first,
    fleet,
    platform,
    idleStopMs: IDLE,
    rebuild: async () => {
      rebuilds += 1
      const made = await fleet.create(SPEC)
      await fleet.box(made).start()
      return made
    },
  })
  box.follow()
  t.after(async () => { await box.close() })
  fleet.calls.length = 0
  return { box, fleet, platform, work, rebuilt: () => rebuilds }
}

test('a box is held started, and occupied without starting it; one the gateway says is gone is set up again, once', async (t) => {
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
  box.copyInOnce(join(work, 'notes.csv'), '/tau/attachments/notes.csv')
  box.copyInOnce(join(work, 'notes.csv'), '/tau/attachments/notes.csv')
  await box.hold({ kind: 'file', id: 'after' })
  assert.deepEqual(fleet.calls, ['start', 'put /tau/attachments'])
  // Readable by all, and writable by none.
  const copied = join(fleet.root(box.box), 'tau/attachments/notes.csv')
  assert.equal(await readFile(copied, 'utf8'), 'a,b\n')
  assert.equal((await stat(copied)).mode & 0o777, 0o444)
  fleet.failing = 'put'
  box.copyInOnce(join(work, 'notes.csv'), '/tau/attachments/other.csv')
  await box.hold({ kind: 'file', id: 'after' }).catch(() => {})
  fleet.failing = undefined
  fleet.calls.length = 0
  box.copyInOnce(join(work, 'notes.csv'), '/tau/attachments/other.csv')
  await box.hold({ kind: 'file', id: 'again' })
  assert.deepEqual(fleet.calls.filter(call => call.startsWith('put')), ['put /tau/attachments'])
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

test('a box started and idle is stopped after the idle time, whoever started it; what occupies it keeps it, even a stop already due', async (t) => {
  const { box, fleet, platform } = await make(t)
  const held = await box.hold({ kind: 'file', id: 'a' })
  platform.advance(5 * IDLE)
  await settled()
  assert.deepEqual(fleet.calls, ['start'], 'occupied, it runs on')
  held?.release()
  platform.advance(IDLE - 1)
  await settled()
  assert.deepEqual(fleet.calls, ['start'])
  platform.advance(1)
  await settled()
  assert.deepEqual(fleet.calls, ['start', 'stop'])
  assert.equal(box.isStarted(), false)

  // Started by other means, as with the `fleet` command, or by a dsh before this one.
  await fleet.box(box.box).start()
  platform.advance(IDLE)
  await settled()
  assert.deepEqual(fleet.calls, ['start', 'stop', 'start', 'stop'])

  // Its stop due, the box is taken before the stop runs: it is not stopped.
  await fleet.box(box.box).start()
  platform.advance(IDLE)
  const release = box.occupy({ kind: 'turn', id: 'agent' })
  await settled()
  assert.deepEqual(fleet.calls, ['start', 'stop', 'start', 'stop', 'start'])
  release()
  platform.advance(IDLE)
  await settled()
  assert.equal(fleet.calls.at(-1), 'stop')
})

test('once its run ended, a box stops as soon as nothing occupies it; started again, it idles for the idle time', async (t) => {
  const { box, fleet, platform } = await make(t)
  const held = await box.hold({ kind: 'terminal', id: 'shell' })
  box.runEnded()
  await settled()
  assert.deepEqual(fleet.calls, ['start'], 'a user\'s terminal keeps it')
  held?.release()
  platform.advance(0)
  await settled()
  assert.deepEqual(fleet.calls, ['start', 'stop'])
  ;(await box.hold({ kind: 'file', id: 'later' }))?.release()
  platform.advance(IDLE - 1)
  await settled()
  assert.deepEqual(fleet.calls, ['start', 'stop', 'start'])
  platform.advance(1)
  await settled()
  assert.deepEqual(fleet.calls, ['start', 'stop', 'start', 'stop'])
})

test('closing stops a box that is started, and nothing after', async (t) => {
  const { box, fleet, platform } = await make(t)
  ;(await box.hold({ kind: 'file', id: 'a' }))?.release()
  await box.close()
  assert.deepEqual(fleet.calls, ['start', 'stop'])
  await fleet.box(box.box).start()
  platform.advance(IDLE)
  await settled()
  assert.deepEqual(fleet.calls, ['start', 'stop', 'start'], 'no longer followed, it is let be')
})
