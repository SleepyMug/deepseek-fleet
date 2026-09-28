import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { FleetServices } from './services.ts'

let dir: string
let manifest: string

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-tau-services-'))
  manifest = join(dir, 'notes.d.ts')
  await writeFile(manifest, [
    '/** Notes. @packageDocumentation */',
    'export interface Note { id: number; text: string }',
    'export declare function addNote(text: string, tags?: string[]): Promise<Note>;',
    'export declare function wait(ms: number): Promise<void>;',
    '',
  ].join('\n'))
})

after(async () => { await rm(dir, { recursive: true, force: true }) })

async function setup(): Promise<FleetServices> {
  const ctx = new Context()
  await ctx.plugin(FleetServices)
  let services: FleetServices | undefined
  await ctx.plugin({ name: 'caller', inject: ['fleetServices'], apply: (inner: Context) => { services = inner.fleetServices } })
  assert.ok(services !== undefined)
  return services
}

const session = 'session-a' as SessionId
const never = new AbortController().signal

test('a provider serves calls whose arguments and result fit its manifest', async () => {
  const services = await setup()
  const calls: unknown[] = []
  const dispose = await services.provide({
    manifest,
    timeoutMs: 100,
    functions: {
      addNote: (args, call) => { calls.push([args, call.session]); return { id: 1, text: args[0]!, extra: 'dropped' } },
      wait: ([ms], { signal }) => new Promise((resolve) => { setTimeout(resolve, ms as number); signal.addEventListener('abort', () => { resolve(undefined) }) }),
    },
  })
  assert.deepEqual(services.list().map(({ name, functions }) => [name, functions]), [['notes', ['addNote', 'wait']]])
  assert.deepEqual(await services.call(session, { service: 'notes', function: 'addNote', args: ['milk'] }, never), { id: 1, text: 'milk' })
  assert.deepEqual(calls, [[['milk'], session]])
  await assert.rejects(services.call(session, { service: 'notes', function: 'addNote', args: [42] }, never))
  await assert.rejects(services.call(session, { service: 'notes', function: 'wait', args: [1000] }, never), /ran longer than 0\.1 s/u)
  await assert.rejects(services.call(session, { service: 'notes', function: 'nope', args: [] }, never), /no function nope/u)
  dispose()
  await assert.rejects(services.call(session, { service: 'notes', function: 'addNote', args: ['x'] }, never), /nothing provides/u)
})

test('a provider must give exactly the manifest\'s functions, once', async () => {
  const services = await setup()
  await assert.rejects(services.provide({ manifest, functions: { addNote: () => null } }), /missing: wait/u)
  await assert.rejects(services.provide({ manifest, functions: { addNote: () => null, wait: () => null, extra: () => null } }), /not declared: extra/u)
  await services.provide({ manifest, functions: { addNote: () => null, wait: () => null } })
  await assert.rejects(services.provide({ manifest, functions: { addNote: () => null, wait: () => null } }), /provided already/u)
})
