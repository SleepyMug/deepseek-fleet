import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tauModel } from './model.ts'
import { Config } from './model-plugin.ts'

test('the model has a route of a provider and its model, and an effort, each of them unset or empty to follow dsh\'s default', () => {
  assert.deepEqual(tauModel({}), {})
  assert.deepEqual(tauModel({ provider: '', model: '', reasoningEffort: '' }), {})
  assert.deepEqual(tauModel({ provider: 'mock', model: 'mock-model' }), { route: { provider: 'mock', model: 'mock-model' } })
  assert.deepEqual(tauModel({ provider: 'mock', model: 'mock-model', reasoningEffort: 'high' }), { route: { provider: 'mock', model: 'mock-model' }, reasoningEffort: 'high' })
  assert.deepEqual(tauModel({ reasoningEffort: 'low' }), { reasoningEffort: 'low' })
})

test('a provider without its model, or a model without its provider, fails', () => {
  assert.throws(() => tauModel({ provider: 'mock' }), /provider and model are given together/u)
  assert.throws(() => tauModel({ model: 'mock-model', reasoningEffort: 'high' }), /provider and model are given together/u)
})

test('fleet-tau-model\'s config keeps the model\'s fields as references, each unset by default', () => {
  const config = Config({ provider: 'mock', model: 'mock-model' })
  assert.equal(config.provider.get(), 'mock')
  assert.equal(config.model.get(), 'mock-model')
  assert.equal(config.reasoningEffort.get(), undefined)
  assert.equal(Config({}).provider.get(), undefined)
})
