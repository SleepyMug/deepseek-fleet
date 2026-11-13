import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boxPath, decodeCaller, encodeCaller, routeOf, servicePath } from './wire.ts'

test('a call\'s path says where it goes, a service or box not named rightly nowhere', () => {
  assert.deepEqual(routeOf(`${servicePath('notes')}/notes.v1.Notes/Add`), { kind: 'service', name: 'notes', path: '/notes.v1.Notes/Add' })
  assert.deepEqual(routeOf(`${boxPath('box-0123456789abcdef')}/fleet.box.v1.Box/Exec`), { kind: 'box', box: 'box-0123456789abcdef', path: '/fleet.box.v1.Box/Exec' })
  assert.deepEqual(routeOf('/fleet.v1.Boxes/List'), { kind: 'gateway', path: '/fleet.v1.Boxes/List' })
  assert.equal(routeOf('/services/Notes/x.Y/Z'), undefined)
  assert.equal(routeOf('/boxes/box-1/fleet.box.v1.Box/Exec'), undefined)
  assert.equal(routeOf('/elsewhere'), undefined)
})

test('a caller goes through its header as it is', () => {
  const caller = decodeCaller(encodeCaller({ caller: { case: 'box', value: { id: 'box-0123456789abcdef', labels: { who: 'me' } } } }))
  assert.equal(caller.caller.case, 'box')
  assert.deepEqual(caller.caller.case === 'box' ? { ...caller.caller.value.labels } : {}, { who: 'me' })
  assert.equal(decodeCaller(encodeCaller({ caller: { case: 'client', value: {} } })).caller.case, 'client')
})
