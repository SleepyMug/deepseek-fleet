import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModelCatalog, RemoteResult, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { choicesOf, effortsOf, routeKey } from './catalog.ts'
import type { TauModelValue } from './catalog.ts'
import { TauModelController } from './controller.ts'
import type { TauModelForm } from './controller.ts'

const CATALOG = {
  default: { provider: 'mock', model: 'mock-model' },
  routableProviders: ['mock', 'codex'],
  groups: [
    { id: 'mock', name: 'Mock', models: [{ id: 'mock-model', name: 'Mock', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }] },
    { id: 'codex', name: 'Codex', models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra' }] },
    { id: 'empty', name: 'Empty', models: [] },
  ],
  failures: [],
} as unknown as ModelCatalog

test('the page offers the catalog\'s models by provider, dsh\'s default by name, and a saved route the catalog has not as unavailable', () => {
  const choices = choicesOf(CATALOG, { provider: 'gone', model: 'old' })
  assert.deepEqual(choices.groups.map(group => [group.name, group.models.map(model => model.name)]), [['Mock', ['Mock']], ['Codex', ['GPT-6 Astra']]])
  assert.deepEqual(choices.unavailable, { key: routeKey({ provider: 'gone', model: 'old' }), route: { provider: 'gone', model: 'old' }, name: 'gone/old' })
  assert.deepEqual(choices.defaultModel, { route: { provider: 'mock', model: 'mock-model' }, name: 'Mock' })
  assert.equal(choicesOf(CATALOG, { provider: 'codex', model: 'gpt-6-astra' }).unavailable, undefined)
})

test('the efforts are the chosen model\'s, or, with none chosen, dsh\'s default\'s', () => {
  assert.deepEqual(effortsOf(CATALOG, { provider: 'codex', model: 'gpt-6-astra' }), { efforts: [], defaultEffort: undefined })
  assert.deepEqual(effortsOf(CATALOG, null).efforts.map(effort => effort.id), ['low', 'high'])
  assert.equal(effortsOf(CATALOG, null).defaultEffort, 'high')
  assert.deepEqual(effortsOf(undefined, null), { efforts: [], defaultEffort: undefined })
})

/** fleet-tau-model's form, as dsh's settings would serve it: a write lands, or not, and moves the revision. */
class FakeForm implements TauModelForm {
  snapshot: ConfigFormSnapshot<TauModelValue>
  writes: { ops: readonly SettingsPathOpView[], revision: number | undefined }[] = []
  accept = true
  private readonly listeners = new Set<() => void>()

  constructor(value: TauModelValue) {
    this.snapshot = { status: 'ready', value, base: {}, user: {}, revision: 1, writable: true, mode: 'host' }
  }

  getSnapshot(): ConfigFormSnapshot<TauModelValue> { return this.snapshot }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async mutate(ops: readonly SettingsPathOpView[], revision?: number): Promise<boolean> {
    this.writes.push({ ops, revision })
    if (!this.accept || revision !== this.snapshot.revision) return false
    const value: Record<string, string | undefined> = { ...this.snapshot.value }
    for (const op of ops) value[op.path[0]!] = op.op === 'set' ? String(op.value) : undefined
    this.change(value)
    return true
  }

  /** A change of the config, as another editor's save. */
  change(value: TauModelValue): void {
    this.snapshot = { ...this.snapshot, value, revision: (this.snapshot.revision ?? 0) + 1 }
    for (const listener of this.listeners) listener()
  }
}

function catalogSource(): { modelCatalog(): Promise<RemoteResult<ModelCatalog>>, calls: number } {
  const source = {
    calls: 0,
    async modelCatalog(): Promise<RemoteResult<ModelCatalog>> {
      source.calls++
      return { ok: true, value: CATALOG } as RemoteResult<ModelCatalog>
    },
  }
  return source
}

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

test('the catalog loads when the page asks, once', async () => {
  const source = catalogSource()
  const controller = new TauModelController(new FakeForm({}), source)
  assert.equal(controller.store.getSnapshot().catalogStatus, 'idle')
  controller.load()
  controller.load()
  await settle()
  assert.equal(source.calls, 1)
  assert.equal(controller.store.getSnapshot().catalogStatus, 'ready')
  assert.equal(controller.store.getSnapshot().choices.groups.length, 2)
})

test('a model chosen is a draft, its effort the model\'s own, until saved, which writes the three fields at the revision it was made on', async () => {
  const form = new FakeForm({ provider: 'mock', model: 'mock-model', reasoningEffort: 'low' })
  const controller = new TauModelController(form, catalogSource())
  controller.load()
  await settle()
  controller.chooseModel(routeKey({ provider: 'codex', model: 'gpt-6-astra' }))
  const draft = controller.store.getSnapshot()
  assert.deepEqual([draft.route, draft.effort, draft.dirty], [{ provider: 'codex', model: 'gpt-6-astra' }, null, true])
  await controller.save()
  assert.deepEqual(form.writes, [{
    ops: [
      { op: 'set', path: ['provider'], value: 'codex' },
      { op: 'set', path: ['model'], value: 'gpt-6-astra' },
      { op: 'unset', path: ['reasoningEffort'] },
    ],
    revision: 1,
  }])
  const saved = controller.store.getSnapshot()
  assert.deepEqual([saved.route, saved.effort, saved.dirty, saved.failed], [{ provider: 'codex', model: 'gpt-6-astra' }, null, false, false])
})

test('dsh\'s default unsets the route, an effort alone stays, and a model unknown to the catalog cannot be chosen', async () => {
  const form = new FakeForm({ provider: 'codex', model: 'gpt-6-astra' })
  const controller = new TauModelController(form, catalogSource())
  controller.load()
  await settle()
  controller.chooseModel(routeKey({ provider: 'nowhere', model: 'x' }))
  assert.equal(controller.store.getSnapshot().dirty, false)
  controller.chooseModel('')
  controller.chooseEffort('low')
  assert.equal(controller.store.getSnapshot().efforts.defaultEffort, 'high')
  await controller.save()
  assert.deepEqual(form.writes[0]?.ops, [
    { op: 'unset', path: ['provider'] },
    { op: 'unset', path: ['model'] },
    { op: 'set', path: ['reasoningEffort'], value: 'low' },
  ])
  assert.deepEqual(form.snapshot.value, { provider: undefined, model: undefined, reasoningEffort: 'low' })
})

test('a draft back to what is saved is none', () => {
  const controller = new TauModelController(new FakeForm({ reasoningEffort: 'low' }), catalogSource())
  controller.chooseEffort('high')
  assert.equal(controller.store.getSnapshot().dirty, true)
  controller.chooseEffort('low')
  assert.equal(controller.store.getSnapshot().dirty, false)
})

test('a change elsewhere while a draft is made conflicts with it, which blocks its save until discarded', async () => {
  const form = new FakeForm({})
  const controller = new TauModelController(form, catalogSource())
  controller.chooseEffort('high')
  form.change({ reasoningEffort: 'low' })
  const conflicted = controller.store.getSnapshot()
  assert.deepEqual([conflicted.conflicted, conflicted.invalid, conflicted.effort], [true, true, 'high'])
  await controller.save()
  assert.deepEqual(form.writes, [])
  controller.discard()
  const discarded = controller.store.getSnapshot()
  assert.deepEqual([discarded.conflicted, discarded.dirty, discarded.effort], [false, false, 'low'])
})

test('a change elsewhere to what the draft is ends the draft', () => {
  const form = new FakeForm({})
  const controller = new TauModelController(form, catalogSource())
  controller.chooseEffort('high')
  form.change({ reasoningEffort: 'high' })
  assert.deepEqual([controller.store.getSnapshot().dirty, controller.store.getSnapshot().conflicted], [false, false])
})

test('a save the host refuses keeps the draft, failed', async () => {
  const form = new FakeForm({})
  form.accept = false
  const controller = new TauModelController(form, catalogSource())
  controller.chooseEffort('high')
  await controller.save()
  const state = controller.store.getSnapshot()
  assert.deepEqual([state.failed, state.dirty, state.effort], [true, true, 'high'])
})

test('nothing can be chosen while the profile is read-only', () => {
  const form = new FakeForm({})
  form.snapshot = { ...form.snapshot, writable: false }
  const controller = new TauModelController(form, catalogSource())
  controller.chooseEffort('high')
  assert.equal(controller.store.getSnapshot().dirty, false)
})

test('a refresh of the catalog while a save crosses the wire still settles the save', async () => {
  const form = new FakeForm({})
  const source = catalogSource()
  const controller = new TauModelController(form, source)
  controller.load()
  await settle()
  controller.chooseEffort('high')
  const saving = controller.save()
  controller.refreshCatalog()
  await saving
  await settle()
  assert.deepEqual([controller.store.getSnapshot().saving, controller.store.getSnapshot().dirty], [false, false])
  assert.equal(source.calls, 2)
})
