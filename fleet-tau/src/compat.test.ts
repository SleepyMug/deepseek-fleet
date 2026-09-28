import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkServices, type Declared } from './compat.ts'

const note = 'export interface Note { id: number; text: string; tags: string[] }\n'
const provided: Declared = {
  name: 'notes',
  declarations: `${note}export declare function addNote(text: string, tags?: string[]): Promise<Note>;\nexport declare function byTag(tag: string): Promise<Note[]>;\n`,
  functions: ['addNote', 'byTag'],
}

const declaring = (declarations: string, functions: string[]): Declared => ({ name: 'notes', declarations, functions })

test('an agent may declare a subset of a service, with narrower parameters and a wider result', () => {
  assert.deepEqual(checkServices([provided], [provided]), [])
  assert.deepEqual(checkServices([declaring(`${note}export declare function addNote(text: "milk" | "bread"): Promise<{ id: number } | null>;\n`, ['addNote'])], [provided]), [])
  assert.deepEqual(checkServices([], [provided]), [])
})

test('a service nothing provides, or a function its provider lacks, is a problem', () => {
  assert.deepEqual(checkServices([{ ...provided, name: 'calendar' }], [provided]), ['no fleet plugin provides the service calendar'])
  const problems = checkServices([declaring('export declare function removeNote(id: number): Promise<void>;\n', ['removeNote'])], [provided])
  assert.deepEqual(problems, ['notes.removeNote: the provided notes has no function removeNote'])
})

test('a wider parameter or a narrower result than the provider\'s is a problem, named by its function', () => {
  const wider = checkServices([declaring('export declare function byTag(tag: string | number): Promise<unknown[]>;\n', ['byTag'])], [provided])
  assert.equal(wider.length, 1)
  assert.match(wider[0]!, /^notes\.byTag: the provided function does not fit the declared one: /u)
  const narrower = checkServices([declaring('export declare function byTag(tag: string): Promise<{ id: number; text: string; tags: string[]; color: string }[]>;\n', ['byTag'])], [provided])
  assert.equal(narrower.length, 1)
  assert.match(narrower[0]!, /^notes\.byTag: /u)
  const required = checkServices([declaring('export declare function addNote(text: string): Promise<unknown>;\n', ['addNote'])], [{
    ...provided, declarations: `${note}export declare function addNote(text: string, tags: string[]): Promise<Note>;\nexport declare function byTag(tag: string): Promise<Note[]>;\n`,
  }])
  assert.equal(required.length, 1, 'a provider requiring an argument the agent may leave out does not fit')
})
