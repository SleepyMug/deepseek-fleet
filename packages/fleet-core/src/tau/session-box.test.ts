import assert from 'node:assert/strict'
import { test } from 'node:test'
import { manualPlatform, type ManualPlatform } from '../platform.test.util.ts'
import type { RunBox } from './ports.ts'
import { type Boxes, SessionBox } from './session-box.ts'

const SESSION = 'session-11111111-1111-4111-8111-111111111111'
const CONTAINER = 'fleet-tau-11111111-1111-4111-8111-111111111111'
const IDLE_MS = 1_000

/** Boxes that record what is done with them, and fail the verb `failing` names. */
class FakeBoxes implements Boxes {
  readonly calls: string[] = []
  readonly existing = new Set<string>([CONTAINER])
  failing: string | undefined

  create(name: string): Promise<RunBox> {
    this.calls.push(`create ${name}`)
    this.existing.add(name)
    return Promise.resolve(this.box(name))
  }

  open(name: string): Promise<RunBox> {
    if (!this.existing.has(name)) return Promise.reject(new Error(`No such container: ${name}`))
    this.calls.push(`open ${name}`)
    return Promise.resolve(this.box(name))
  }

  exists(name: string): Promise<boolean> {
    return Promise.resolve(this.existing.has(name))
  }

  private box(name: string): RunBox {
    const record = (verb: string, call: string): void => {
      this.calls.push(call)
      if (verb === this.failing) throw new Error(`${verb} failed`)
    }
    return {
      container: name,
      start: async () => { record('start', 'start') },
      stop: async () => { record('stop', 'stop') },
      remove: async () => {
        record('remove', 'remove')
        this.existing.delete(name)
      },
      copyIn: async (from, to) => { record('copyIn', `copyIn ${from} ${to}`) },
      pipe: async () => { record('pipe', 'pipe') },
      request: (async (method: string, params: unknown) => {
        record(method, `${method} ${JSON.stringify(params)}`)
        return { code: 0, signal: null, stdout: '', stderr: '' }
      }) as RunBox['request'],
    }
  }
}

/** A session's box on fake boxes and a manual platform; set up again, its container gone, by creating it. */
function make(): { box: SessionBox; boxes: FakeBoxes; platform: ManualPlatform; rebuilt: () => number } {
  const boxes = new FakeBoxes()
  const platform = manualPlatform()
  let rebuilds = 0
  const box = new SessionBox({
    sessionId: SESSION,
    container: CONTAINER,
    boxes,
    platform,
    idleStopMs: IDLE_MS,
    calls: async () => null,
    rebuild: async () => {
      rebuilds += 1
      const created = await boxes.create(CONTAINER)
      await created.start()
      return created
    },
  })
  return { box, boxes, platform, rebuilt: () => rebuilds }
}

/** Let what a timer started run its course. */
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

test('a box nothing occupies is stopped once it was idle long enough, and not while anything occupies it', async () => {
  const { box, boxes, platform } = make()
  const terminal = await box.hold({ kind: 'terminal', id: 'shell' })
  const file = await box.hold({ kind: 'file', id: 'read' })
  file?.release()
  file?.release()
  assert.deepEqual(box.occupied(), [{ kind: 'terminal', id: 'shell' }])
  platform.advance(IDLE_MS * 3)
  await settle()
  assert.deepEqual(boxes.calls, [`open ${CONTAINER}`, 'start'])
  terminal?.release()
  platform.advance(IDLE_MS - 1)
  await settle()
  assert.deepEqual(boxes.calls.slice(1), ['start'])
  platform.advance(1)
  await settle()
  assert.deepEqual(boxes.calls.slice(1), ['start', 'stop'])
  assert.equal(box.isStarted(), false)

  // A use while it waits keeps it running, until that use is done too.
  const first = await box.hold({ kind: 'process', id: 'one' })
  first?.release()
  const second = await box.hold({ kind: 'process', id: 'two' })
  platform.advance(IDLE_MS)
  await settle()
  assert.deepEqual(boxes.calls.slice(1), ['start', 'stop', 'start'])
  second?.release()
  platform.advance(IDLE_MS)
  await settle()
  assert.deepEqual(boxes.calls.slice(1), ['start', 'stop', 'start', 'stop'])
})

test('a box asked to stop once vacant stops at once, unless something occupies it, and then as soon as nothing does', async () => {
  const { box, boxes, platform } = make()
  const terminal = await box.hold({ kind: 'terminal', id: 'shell' })
  await box.stopWhenVacant()
  assert.notEqual(boxes.calls.at(-1), 'stop')
  terminal?.release()
  // Not after the box's idle time, but at once.
  platform.advance(0)
  await settle()
  assert.equal(boxes.calls.at(-1), 'stop')
  await box.hold({ kind: 'call', id: 'again' }).then(held => held?.release())
  await box.stopWhenVacant()
  assert.equal(boxes.calls.at(-1), 'stop')
})

test('waiting for a box to be started starts nothing, and fails once the session is gone', async () => {
  const { box, boxes } = make()
  const waiting = box.whenStarted(new AbortController().signal)
  const giving = new AbortController()
  const givenUp = box.whenStarted(giving.signal)
  await settle()
  assert.deepEqual(boxes.calls, [])
  giving.abort()
  await assert.rejects(givenUp)
  await box.hold({ kind: 'call', id: 'use' }).then(held => held?.release())
  assert.equal((await waiting).container, CONTAINER)
  assert.equal((await box.whenStarted(new AbortController().signal)).container, CONTAINER)
  await box.stop()
  const gone = box.whenStarted(new AbortController().signal)
  let forgotten = false
  await box.remove(async () => { forgotten = true })
  assert.equal(forgotten, true)
  await assert.rejects(gone, /no tau session/u)
  assert.equal(await box.hold({ kind: 'call', id: 'late' }), undefined)
  await assert.rejects(box.remove(async () => {}), /no tau session/u)
})

test('a host file is copied into a box once, before its next use, and again after a failure', async () => {
  const { box, boxes, platform } = make()
  const from = '/home/me/.dsh/attachments/v1/objects/09/0912'
  const to = '/fleet/attachments/v1/objects/09/0912'
  const copy = [
    'exec {"argv":["mkdir","-p","/fleet/attachments/v1/objects/09"]}',
    `copyIn ${from} ${to}`,
    `exec {"argv":["chmod","a=r","${to}"]}`,
  ]
  box.copyInOnce(from, to)
  box.copyInOnce(from, to)
  await box.hold({ kind: 'call', id: 'use' }).then(held => held?.release())
  assert.deepEqual(boxes.calls, [`open ${CONTAINER}`, 'start', ...copy])
  box.copyInOnce(from, to)
  await box.hold({ kind: 'call', id: 'use' }).then(held => held?.release())
  assert.deepEqual(boxes.calls, [`open ${CONTAINER}`, 'start', ...copy])

  boxes.calls.length = 0
  boxes.failing = 'copyIn'
  const other = '/fleet/attachments/v1/objects/ab/ab34'
  box.copyInOnce(from, other)
  await box.hold({ kind: 'call', id: 'use' }).then(held => held?.release())
  assert.match(platform.logged.at(-1) ?? '', /^could not copy .* into the box of session-.*: copyIn failed$/)
  boxes.failing = undefined
  box.copyInOnce(from, other)
  await box.hold({ kind: 'call', id: 'use' }).then(held => held?.release())
  assert.deepEqual(boxes.calls.filter(call => call.startsWith('copyIn')), [`copyIn ${from} ${other}`, `copyIn ${from} ${other}`])
})

test('an archived box is removed, and none is had until it is unarchived; then, its container gone, it is set up again', async () => {
  const { box, boxes, rebuilt } = make()
  await box.hold({ kind: 'call', id: 'use' }).then(held => held?.release())
  await box.archive()
  assert.equal(await boxes.exists(CONTAINER), false)
  assert.equal(box.isArchived(), true)
  await assert.rejects(box.hold({ kind: 'call', id: 'use' }), /is archived/u)
  box.unarchive()
  boxes.calls.length = 0
  const held = await box.hold({ kind: 'call', id: 'use' })
  held?.release()
  assert.equal(rebuilt(), 1)
  assert.deepEqual(boxes.calls, [`create ${CONTAINER}`, 'start'])
  assert.equal(box.isStarted(), true)
})
