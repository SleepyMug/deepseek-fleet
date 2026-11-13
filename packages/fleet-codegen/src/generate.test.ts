import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createServer } from 'node:http2'
import { fromBinary } from '@bufbuild/protobuf'
import { durationFromMs, FileDescriptorSetSchema, timestampFromDate } from '@bufbuild/protobuf/wkt'
import { connectNodeAdapter } from '@connectrpc/connect-node'
import { createFileRegistry } from '@bufbuild/protobuf'
import { stageModules } from '@sleepymug/fleet-pack'
import { generateClient, runtimeRoots, SchemaError } from './index.ts'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

/** The test's schema, as `buf build` makes it, with its comments. */
async function schema(dir: string) {
  await mkdir(join(dir, 'proto'), { recursive: true })
  await run('cp', ['-r', join(HERE, '..', 'src', 'test-proto', 'notes'), join(dir, 'proto')])
  await writeFile(join(dir, 'proto', 'buf.yaml'), 'version: v2\n')
  await run(join(ROOT, 'node_modules', '.bin', 'buf'), ['build', '--output', join(dir, 'schema.binpb')], { cwd: join(dir, 'proto') })
  return fromBinary(FileDescriptorSetSchema, await readFile(join(dir, 'schema.binpb')))
}

const PLACE = (dir: string) => ({ package: '@fleet/notes', socket: join(dir, 'services.sock'), socketVariable: 'FLEET_SERVICES_SOCKET', path: '/services/notes', dir: '/fleet/node_modules/@fleet/notes' })

test('a client calls its service through the socket with plain objects, its declarations whole in one file, carrying the schema\'s comments, and typed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-codegen-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const set = await schema(dir)
  const client = generateClient({ name: 'notes', description: 'A notebook of short notes.', schema: set, services: ['notes.v1.Notes'] }, PLACE(dir))
  assert.deepEqual([...client.files.keys()].sort(), ['README.md', 'index.d.ts', 'index.js', 'package.json'])
  const declarations = client.files.get('index.d.ts') as string
  assert.doesNotMatch(declarations, /import|protobuf|Schema|bigint/u)
  assert.match(declarations, /export declare const notes: \{\n {2}\/\*\* Keep a note, and give it back with its number\. \*\/\n {2}add\(request: AddRequest\): Promise<Note>\n/u)
  assert.match(declarations, /tagged\(request: TaggedRequest\): AsyncIterable<Note>/u)
  assert.match(declarations, /addAll\(requests: Iterable<AddRequest> \| AsyncIterable<AddRequest>\): Promise<Total>/u)
  assert.match(declarations, /count\(request\?: CountRequest\): Promise<Total>/u)
  assert.match(declarations, /export type Note = \{\n {2}\/\*\* Its number in its notebook\. \*\/\n {2}id: number\n/u)
  assert.match(declarations, /written\?: Date\n/u)
  assert.match(declarations, /attachment: Uint8Array\n/u)
  assert.match(declarations, /\/\*\* How long it is kept\. In milliseconds\. \*\/\n {2}kept\?: number\n/u)
  assert.match(declarations, /\} & \(\n {2}\/\/ Where it came from\.\n {2}\| \{ \/\*\* Fetched from here\. \*\/ url: string; box\?: never \}\n {2}\| \{ \/\*\* Copied from this box\. \*\/ box: string; url\?: never \}\n {2}\| \{ url\?: never; box\?: never \}\n\)/u)
  assert.match(declarations, /\* How soon a note matters\.\n \* - `'PRIORITY_LOW'`: Whenever\.\n \* - `'PRIORITY_HIGH'`: Now\.\n \*\/\nexport type Priority = 'PRIORITY_UNSPECIFIED' \| 'PRIORITY_LOW' \| 'PRIORITY_HIGH'/u)
  assert.match(client.readme, /`notes\.add\(request\)`, answers a `Note`: Keep a note, and give it back with its number\./u)
  assert.match(client.readme, /curl -s --unix-socket .* http:\/\/fleet\/services\/notes\/notes\.v1\.Notes\/Add/u)

  // As the box has it: the client in node_modules/@fleet/notes, and what it imports beside it.
  const box = join(dir, 'box')
  await stageModules(await runtimeRoots(), box)
  for (const [path, content] of client.files) {
    await mkdir(dirname(join(box, 'node_modules', '@fleet', 'notes', path)), { recursive: true })
    await writeFile(join(box, 'node_modules', '@fleet', 'notes', path), content)
  }
  const registry = createFileRegistry(set)
  const Notes = registry.getService('notes.v1.Notes')
  assert.ok(Notes !== undefined)
  const kept: unknown[] = []
  const server = createServer(connectNodeAdapter({
    requestPathPrefix: '/services/notes',
    routes: router => router.service(Notes, {
      add: (req: { text: string; tags: string[]; priority: number; attachment: Uint8Array; origin: { case?: string; value?: string } }) => {
        kept.push(req)
        return { id: 1, text: req.text, tags: req.tags, priority: req.priority, attachment: req.attachment, size: BigInt(req.attachment.length), origin: req.origin, written: timestampFromDate(new Date('2026-11-13T00:00:00Z')), kept: durationFromMs(1500) }
      },
      async *tagged(req: { tag: string }) { for (const id of [1, 2]) yield { id, text: `note ${id}`, tags: [req.tag] } },
      async addAll(requests: AsyncIterable<unknown>) {
        let count = 0n
        for await (const _ of requests) count++
        return { count }
      },
      count: () => ({ count: 7n }),
    } as never),
  }))
  await new Promise<void>((resolve) => { server.listen(join(dir, 'services.sock'), resolve) })
  t.after(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))

  await writeFile(join(box, 'program.mts'), [
    "import { notes, type Note } from '@fleet/notes'",
    "const note: Note = await notes.add({ text: 'buy milk', tags: ['shop'], priority: 'PRIORITY_HIGH', attachment: Buffer.from('milk'), box: 'box-1' })",
    'const tagged: number[] = []',
    "for await (const each of notes.tagged({ tag: 'shop' })) tagged.push(each.id)",
    "const added = await notes.addAll([{ text: 'a', tags: [], priority: 'PRIORITY_LOW', attachment: new Uint8Array() }, { text: 'b', tags: [], priority: 'PRIORITY_LOW', attachment: new Uint8Array() }])",
    'const count = await notes.count()',
    'let failure = ""',
    "try { await notes.add({ txt: 'oops' } as never) } catch (error) { failure = (error as Error).message }",
    'console.log(JSON.stringify({ note: { ...note, attachment: Buffer.from(note.attachment).toString(), written: note.written?.toISOString() }, tagged, added: added.count, count: count.count, failure }))',
  ].join('\n'))
  await writeFile(join(box, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'nodenext', target: 'es2024', strict: true, noEmit: true, types: ['node'], typeRoots: [join(ROOT, 'node_modules', '@types')], skipLibCheck: false, lib: ['es2024'] }, files: ['program.mts'] }))
  await run(join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', box]).catch((error: { stdout?: string }) => { throw new Error(`the program does not check: ${error.stdout ?? ''}`) })
  const { stdout } = await run(process.execPath, [join(box, 'program.mts')], { cwd: box })
  assert.deepEqual(JSON.parse(stdout), {
    note: { id: 1, text: 'buy milk', tags: ['shop'], priority: 'PRIORITY_HIGH', attachment: 'milk', size: 4, box: 'box-1', written: '2026-11-13T00:00:00.000Z', kept: 1500 },
    tagged: [1, 2],
    added: 2,
    count: 7,
    failure: "Notes.Add's request: AddRequest has no field txt; its fields are text, tags, priority, attachment, url, box",
  })
  assert.deepEqual((kept[0] as { origin: unknown }).origin, { case: 'box', value: 'box-1' })
})

test('a schema missing a file it imports, or the service named, makes no client', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-codegen-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const set = await schema(dir)
  assert.throws(() => generateClient({ name: 'notes', description: '', schema: set, services: ['notes.v1.Nothing'] }, PLACE(dir)), SchemaError)
  const partial = { ...set, file: set.file.filter(file => file.name !== 'google/protobuf/timestamp.proto') }
  assert.throws(() => generateClient({ name: 'notes', description: '', schema: partial, services: ['notes.v1.Notes'] }, PLACE(dir)), SchemaError)
})
