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
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt'
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

test('a client calls its service through the socket, its declarations carrying the schema\'s comments, and typed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-codegen-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const set = await schema(dir)
  const client = generateClient({ name: 'notes', description: 'A notebook of short notes.', schema: set, services: ['notes.v1.Notes'] }, PLACE(dir))
  assert.deepEqual([...client.files.keys()].sort(), ['README.md', 'index.d.ts', 'index.js', 'notes/v1/notes_pb.d.ts', 'notes/v1/notes_pb.js', 'package.json'])
  const declarations = client.files.get('index.d.ts') as string
  assert.match(declarations, /Keep a note, and give it back with its number\./u)
  assert.match(declarations, /add\(request: MessageInitShape<typeof AddRequestSchema>, options\?: CallOptions\): Promise<Note>;/u)
  assert.match(declarations, /tagged\(request: MessageInitShape<typeof TaggedRequestSchema>, options\?: CallOptions\): AsyncIterable<Note>;/u)
  assert.match(declarations, /export declare const notes: NotesClient;/u)
  assert.match(client.readme, /`notes\.add\(request\)`, answers a `Note`: Keep a note, and give it back with its number\./u)
  assert.match(client.readme, /curl -s --unix-socket .* http:\/\/fleet\/services\/notes\/notes\.v1\.Notes\/Add/u)

  // As the box has it: the client in node_modules/@fleet/notes, and its runtime beside it.
  const box = join(dir, 'box')
  await stageModules(await runtimeRoots(), box)
  for (const [path, content] of client.files) {
    await mkdir(dirname(join(box, 'node_modules', '@fleet', 'notes', path)), { recursive: true })
    await writeFile(join(box, 'node_modules', '@fleet', 'notes', path), content)
  }
  const registry = createFileRegistry(set)
  const Notes = registry.getService('notes.v1.Notes')
  assert.ok(Notes !== undefined)
  const server = createServer(connectNodeAdapter({
    requestPathPrefix: '/services/notes',
    routes: router => router.service(Notes, {
      add: (req: { text: string; tags: string[] }) => ({ id: 1, text: req.text, tags: req.tags }),
      async *tagged(req: { tag: string }) { for (const id of [1, 2]) yield { id, text: `note ${id}`, tags: [req.tag] } },
    } as never),
  }))
  await new Promise<void>((resolve) => { server.listen(join(dir, 'services.sock'), resolve) })
  t.after(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))

  await writeFile(join(box, 'program.mts'), [
    "import { notes, type Note } from '@fleet/notes'",
    "const note: Note = await notes.add({ text: 'buy milk', tags: ['shop'] })",
    'const tagged: number[] = []',
    "for await (const each of notes.tagged({ tag: 'shop' })) tagged.push(each.id)",
    'console.log(JSON.stringify({ id: note.id, text: note.text, tagged }))',
  ].join('\n'))
  await writeFile(join(box, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'nodenext', target: 'es2024', strict: true, noEmit: true, types: [], skipLibCheck: false, lib: ['es2024', 'dom'] }, files: ['program.mts'] }))
  await run(join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', box]).catch((error: { stdout?: string }) => { throw new Error(`the program does not check: ${error.stdout ?? ''}`) })
  const { stdout } = await run(process.execPath, [join(box, 'program.mts')], { cwd: box })
  assert.deepEqual(JSON.parse(stdout), { id: 1, text: 'buy milk', tagged: [1, 2] })
})

test('a schema missing a file it imports, or the service named, makes no client', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-codegen-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const set = await schema(dir)
  assert.throws(() => generateClient({ name: 'notes', description: '', schema: set, services: ['notes.v1.Nothing'] }, PLACE(dir)), SchemaError)
  const partial = { ...set, file: set.file.filter(file => file.name !== 'google/protobuf/timestamp.proto') }
  assert.throws(() => generateClient({ name: 'notes', description: '', schema: partial, services: ['notes.v1.Notes'] }, PLACE(dir)), SchemaError)
})
