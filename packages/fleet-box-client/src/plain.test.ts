import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createFileRegistry, fromBinary, toBinary, type DescMessage } from '@bufbuild/protobuf'
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt'
import { toMessage, toPlain } from './index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

async function kinds(t: { after: (fn: () => Promise<void>) => void }): Promise<DescMessage> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-box-client-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await cp(join(HERE, '..', 'src', 'test-proto'), join(dir, 'proto'), { recursive: true })
  await writeFile(join(dir, 'proto', 'buf.yaml'), 'version: v2\n')
  await promisify(execFile)(join(ROOT, 'node_modules', '.bin', 'buf'), ['build', '--output', join(dir, 'set.binpb')], { cwd: join(dir, 'proto') })
  const registry = createFileRegistry(fromBinary(FileDescriptorSetSchema, await readFile(join(dir, 'set.binpb'))))
  return registry.getMessage('kinds.v1.Kinds') as DescMessage
}

test('a plain object goes to a message and back as it was, each kind of field in its plain form', async (t) => {
  const Kinds = await kinds(t)
  const plain = {
    text: 'hi',
    flag: true,
    ratio: 0.5,
    count: 42,
    content: Buffer.from('bytes'),
    level: 'LEVEL_HIGH',
    maybe: 'given',
    counts: [1, 2],
    inners: { a: { name: 'A' } },
    inner: { name: 'in' },
    box: { name: 'boxed' },
    made: new Date('2026-11-13T06:12:53.918Z'),
    took: 1500,
    meta: { x: 1, y: ['z'] },
    any: 'anything',
    list: [1, 'two'],
    wrapped: 7,
    names: ['a', 'b'],
    chunks: [new Uint8Array([1, 2])],
  }
  const message = toMessage(Kinds, plain)
  const back = toPlain(Kinds, fromBinary(Kinds, toBinary(Kinds, message)))
  assert.deepEqual({ ...back, content: Buffer.from(back.content as Uint8Array), chunks: (back.chunks as Uint8Array[]).map(chunk => [...chunk]) }, { ...plain, chunks: [[1, 2]] })
  assert.ok(back.made instanceof Date)
})

test('an empty object goes to a message whose plain form has every field without presence, each its zero value', async (t) => {
  const Kinds = await kinds(t)
  const back = toPlain(Kinds, fromBinary(Kinds, toBinary(Kinds, toMessage(Kinds, {}))))
  assert.deepEqual(Object.keys(back).sort(), ['chunks', 'content', 'count', 'counts', 'flag', 'inners', 'level', 'names', 'ratio', 'text'])
  assert.equal(back.count, 0)
  assert.equal(back.level, 'LEVEL_UNSPECIFIED')
  assert.ok(back.content instanceof Uint8Array)
})

test('what does not fit says where and why', async (t) => {
  const Kinds = await kinds(t)
  assert.throws(() => toMessage(Kinds, { txt: 'hi' }), /Kinds has no field txt; its fields are text, flag/u)
  assert.throws(() => toMessage(Kinds, { url: 'u', box: { name: 'b' } }), /url and box are one of source; give one of them at most/u)
  assert.throws(() => toMessage(Kinds, { content: 'not bytes' }), /Kinds\.content: is bytes, a Uint8Array such as a Buffer/u)
  assert.throws(() => toMessage(Kinds, { level: 'HIGH' }), /is one of 'LEVEL_UNSPECIFIED', 'LEVEL_LOW', 'LEVEL_HIGH'/u)
  assert.throws(() => toMessage(Kinds, { count: 1.5 }), /is an integer, not 1\.5/u)
  assert.throws(() => toMessage(Kinds, { inner: { nme: 'x' } }), /Kinds\.inner: Inner has no field nme/u)
})
