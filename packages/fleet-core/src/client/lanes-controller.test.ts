import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { lanesOf, TauLanesController } from './lanes-controller.ts'
import type { TauLanesForm, TauLanesValue } from './lanes-controller.ts'

/** fleet-tau-lanes' form, as dsh's settings would serve it: a write lands, or not, and moves the revision. */
class FakeForm implements TauLanesForm {
  snapshot: ConfigFormSnapshot<TauLanesValue>
  writes: { ops: readonly SettingsPathOpView[], revision: number | undefined }[] = []
  private readonly listeners = new Set<() => void>()

  constructor(value: TauLanesValue) {
    this.snapshot = { status: 'ready', value, base: {}, user: {}, revision: 1, writable: true, mode: 'host' }
  }

  getSnapshot(): ConfigFormSnapshot<TauLanesValue> { return this.snapshot }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async mutate(ops: readonly SettingsPathOpView[], revision?: number): Promise<boolean> {
    this.writes.push({ ops, revision })
    if (revision !== this.snapshot.revision) return false
    const op = ops[0]!
    this.change(op.op === 'set' ? { lanes: op.value as number } : {})
    return true
  }

  /** A change of the config, as another editor's save. */
  change(value: TauLanesValue): void {
    this.snapshot = { ...this.snapshot, value, revision: (this.snapshot.revision ?? 0) + 1 }
    for (const listener of this.listeners) listener()
  }
}

test('a number of lanes is a whole number from 1, or none, for no cap', () => {
  assert.equal(lanesOf(''), null)
  assert.equal(lanesOf(' 4 '), 4)
  for (const text of ['0', '-1', '1.5', 'four', '01', '1e3']) assert.equal(lanesOf(text), undefined, text)
})

test('the page shows the saved lanes, saves a number typed, unsets an empty one, and cannot save one that is not a number', async () => {
  const form = new FakeForm({})
  const page = new TauLanesController(form)
  assert.equal(page.store.getSnapshot().text, '')
  page.type('3')
  assert.equal(page.store.getSnapshot().dirty, true)
  await page.save()
  assert.deepEqual(form.writes.at(-1), { ops: [{ op: 'set', path: ['lanes'], value: 3 }], revision: 1 })
  assert.deepEqual([page.store.getSnapshot().dirty, page.store.getSnapshot().text], [false, '3'])

  page.type('none')
  assert.equal(page.store.getSnapshot().invalid, true)
  assert.equal(page.store.getSnapshot().malformed, true)
  await page.save()
  assert.equal(form.writes.length, 1)
  page.type('')
  await page.save()
  assert.deepEqual(form.writes.at(-1)?.ops, [{ op: 'unset', path: ['lanes'] }])
  assert.equal(page.store.getSnapshot().text, '')
  // Typing what is saved is no draft.
  page.type('')
  assert.equal(page.store.getSnapshot().dirty, false)
})

test('a change saved elsewhere meanwhile conflicts with a draft that differs, and ends one that matches', async () => {
  const form = new FakeForm({ lanes: 2 })
  const page = new TauLanesController(form)
  page.type('5')
  form.change({ lanes: 4 })
  assert.equal(page.store.getSnapshot().conflicted, true)
  await page.save()
  assert.equal(form.writes.length, 0)
  page.discard()
  assert.equal(page.store.getSnapshot().text, '4')
  page.type('6')
  form.change({ lanes: 6 })
  assert.deepEqual([page.store.getSnapshot().dirty, page.store.getSnapshot().conflicted], [false, false])
})
