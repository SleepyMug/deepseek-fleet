import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import * as archives from './archives/index.ts'
import { call, SOCKET_VARIABLE } from './client.ts'
import * as notes from './notes/index.ts'
import { declarations, implementation, implementations } from './registry.ts'
import * as textStats from './text-stats/index.ts'

let dir: string
let server: Server
const calls: { service: string; function: string; args: unknown[] }[] = []
/** How the fake fleet host answers each backend method. */
const answers: Record<string, (args: unknown[]) => unknown> = {
  'notes.addNote': ([text, tags]) => ({ result: { id: 1, text, tags, written: '2026-09-30T12:00:00.000Z' } }),
  'notes.byTag': () => ({ result: [{ id: 1, text: 'milk', tags: ['shopping'], written: '2026-09-30T12:00:00.000Z' }] }),
  'archives.store': ([name, tarball]) => ({ result: { name, bytes: Buffer.from(tarball as string, 'base64').length, sha256: 'x', entries: [] } }),
  'slow.wait': () => undefined,
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-apis-'))
  process.env[SOCKET_VARIABLE] = join(dir, 'fleet.sock')
  // The fleet host as fleet-box's socket relays it: one line in, one line out, or nothing for `slow`.
  server = createServer((socket) => {
    let line = ''
    socket.on('data', (chunk: Buffer) => {
      line += chunk.toString('utf8')
      if (!line.includes('\n')) return
      const request = JSON.parse(line) as (typeof calls)[number]
      calls.push(request)
      const answer = answers[`${request.service}.${request.function}`]?.(request.args) ?? (request.service === 'slow' ? undefined : { error: { message: 'no such method' } })
      if (answer !== undefined) socket.end(`${JSON.stringify(answer)}\n`)
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => { server.listen(process.env[SOCKET_VARIABLE], resolve) })
})

after(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

test('notes come back with their dates as dates', async () => {
  const note = await notes.addNote('milk', ['shopping'])
  assert.deepEqual(note, { id: 1, text: 'milk', tags: ['shopping'], written: new Date('2026-09-30T12:00:00.000Z') })
  assert.deepEqual(calls.at(-1), { service: 'notes', function: 'addNote', args: ['milk', ['shopping']] })
  await notes.addNote('bread')
  assert.deepEqual(calls.at(-1)?.args, ['bread', []])
  const found = await notes.byTag('shopping')
  assert.ok(found[0]?.written instanceof Date)
})

test('a folder is sent as a tarball, as base64, under its own name by default', async () => {
  const folder = join(dir, 'docs')
  await mkdir(join(folder, 'sub'), { recursive: true })
  await writeFile(join(folder, 'a.txt'), 'a')
  const receipt = await archives.archiveDir(folder)
  const [name, encoded] = calls.at(-1)?.args as [string, string]
  const tarball = Buffer.from(encoded, 'base64')
  assert.equal(name, 'docs')
  assert.equal(tarball.subarray(257, 262).toString(), 'ustar')
  assert.equal(receipt.bytes, tarball.length)
  await assert.rejects(archives.archiveDir(join(dir, 'missing')), /tar could not pack/u)
})

test('word frequencies need no fleet host', () => {
  assert.deepEqual(textStats.wordFrequencies('The cat and the hat'), { the: 2, cat: 1, and: 1, hat: 1 })
})

test('a failed call carries the host\'s reason, and an aborted one closes its connection', async () => {
  await assert.rejects(call('notes', 'nope', []), /no such method/u)
  const controller = new AbortController()
  const pending = call('slow', 'wait', [], controller.signal)
  setTimeout(() => { controller.abort(new Error('cancelled')) }, 50)
  await assert.rejects(pending, /cancelled/u)
  const socket = process.env[SOCKET_VARIABLE]
  delete process.env[SOCKET_VARIABLE]
  try {
    await assert.rejects(call('notes', 'addNote', []), /FLEET_SOCKET is not set/u)
  } finally {
    process.env[SOCKET_VARIABLE] = socket
  }
})

test('the registry lists each implementation, its backends, and its declarations', () => {
  assert.deepEqual(implementations().map(({ name, backends }) => [name, backends]), [['archives', ['archives']], ['notes', ['notes']], ['text-stats', []]])
  const found = implementation('notes')
  assert.ok(found !== undefined)
  assert.ok(existsSync(found.file))
  assert.equal(found.image, '/opt/fleet-tau/apis/notes/index.js')
  assert.match(found.description ?? '', /^A notebook of short notes/u)
  // What a tau copies into its api/: the package documentation, and nothing of the client.
  const text = declarations(found)
  assert.match(text, /@packageDocumentation[^]*export declare function addNote\(text: string, tags\?: string\[\]\): Promise<Note>;/u)
  assert.doesNotMatch(text, /client/u)
  assert.equal(implementation('constructor'), undefined)
  assert.equal(implementation('missing'), undefined)
})
