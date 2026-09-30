import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadService } from '@sleepymug/tau'
import { serviceBinding } from './binding.ts'
import type { AgentModule, RunnerReply, RunnerRequest } from './protocol.ts'
import { replyLine } from './report.ts'

const RUNNER = fileURLToPath(new URL('./main.js', import.meta.url))
const CLIENT = fileURLToPath(new URL('./service.js', import.meta.url))

let dir: string
let socketPath: string
let server: Server
const calls: unknown[] = []
/** The packages a program may import, as fleet-tau lays them out in the agent's snapshot. */
let modules: AgentModule[]

/** A module of the agent's, from its files. */
async function writePackage(root: string, files: Record<string, string>): Promise<void> {
  await mkdir(root, { recursive: true })
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text)
}

/** A service's binding, where fleet-tau writes it, from its manifest. */
async function bind(agent: string, name: string, manifest: string): Promise<AgentModule> {
  await writeFile(join(dir, `${name}.d.ts`), manifest)
  const service = loadService(join(dir, `${name}.d.ts`))
  const root = join(agent, 'modules', 'node_modules', '@svc', name)
  await writePackage(root, serviceBinding({ name, declarations: service.declarations, functions: service.functions, schema: service.schema }, CLIENT))
  return { name: `@svc/${name}`, root }
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-tau-runner-'))
  socketPath = join(dir, 'tau.sock')
  // A provider as the host's relay answers: one line in, one line out, bytes as base64.
  server = createServer((socket) => {
    let line = ''
    socket.on('data', (chunk: Buffer) => {
      line += chunk.toString('utf8')
      if (!line.includes('\n')) return
      const call = JSON.parse(line) as { function: string; args: unknown[] }
      calls.push(call)
      const answer = call.function === 'fail'
        ? { error: { message: 'disk full' } }
        : call.function === 'reverse'
          ? { result: Buffer.from(call.args[0] as string, 'base64').reverse().toString('base64') }
          : { result: { id: 7, text: call.args[0] } }
      socket.end(`${JSON.stringify(answer)}\n`)
    })
  })
  await new Promise<void>((resolve) => { server.listen(socketPath, resolve) })
  const agent = join(dir, 'agent')
  const exports = { '.': { types: './index.d.ts', default: './index.js' } }
  modules = [
    await bind(agent, 'notes', 'export interface Note { id: number; text: string }\nexport declare function addNote(text: string, tags?: string[]): Promise<Note>;\nexport declare function fail(): Promise<void>;\n'),
    await bind(agent, 'blobs', 'export declare function reverse(data: Uint8Array): Promise<Uint8Array>;\n'),
    { name: 'shout', description: 'Loud text.', root: join(agent, 'modules', 'shout') },
    { name: 'loud-notes', root: join(agent, 'modules', 'loud-notes') },
  ]
  await writePackage(join(agent, 'modules', 'shout'), {
    'package.json': JSON.stringify({ name: 'shout', description: 'Loud text.', type: 'module', exports }),
    'index.js': 'export function shout(text) { return `${text.toUpperCase()}!!!` }\n',
    'index.d.ts': 'export declare function shout(text: string): string;\n',
  })
  // A module that imports a service, which it finds in modules/node_modules as tau's SPEC.md says.
  await writePackage(join(agent, 'modules', 'loud-notes'), {
    'package.json': JSON.stringify({ name: 'loud-notes', type: 'module', exports }),
    'index.js': 'import { addNote } from "@svc/notes"\nexport function addLoudNote(text) { return addNote(text.toUpperCase()) }\n',
    'index.d.ts': 'import type { Note } from "@svc/notes";\nexport declare function addLoudNote(text: string): Promise<Note>;\n',
  })
})

after(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

function packages() {
  return { root: join(dir, 'root'), modules }
}

/** Run the runner once; `terminateAfterMs` sends it SIGTERM, as the host does on a cancelled call. */
function runner(request: RunnerRequest, options: { terminateAfterMs?: number } = {}): Promise<RunnerReply> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER], { env: { ...process.env, TAU_SOCKET: socketPath }, stdio: ['pipe', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.once('error', reject)
    child.once('close', () => {
      try {
        resolve(JSON.parse(stdout) as RunnerReply)
      } catch (error) {
        reject(new Error(`the runner wrote ${JSON.stringify(stdout)}`, { cause: error }))
      }
    })
    child.stdin.end(JSON.stringify(request))
    if (options.terminateAfterMs !== undefined) setTimeout(() => { child.kill('SIGTERM') }, options.terminateAfterMs)
  })
}

/** A program's value, from a run that must succeed. */
async function value(source: string, input?: unknown): Promise<unknown> {
  const reply = await runner({ command: 'execute', ...packages(), cwd: dir, timeoutMs: 60_000, source, ...input === undefined ? {} : { input } })
  assert.ok(reply.ok && 'value' in reply, JSON.stringify(reply))
  return reply.value
}

test('a program imports its services and the agent\'s modules, and returns JSON', async () => {
  const reply = await runner({
    command: 'execute', ...packages(), cwd: dir, timeoutMs: 60_000, input: { text: 'milk' },
    source: [
      'import { addNote } from "@svc/notes"',
      'import { shout } from "shout"',
      'export async function main(input: { text: string }) {',
      '  console.log("adding")',
      '  const note = await addNote(input.text, undefined)',
      '  return { note, loud: shout(note.text) }',
      '}',
    ].join('\n'),
  })
  assert.deepEqual(reply, { ok: true, value: { note: { id: 7, text: 'milk' }, loud: 'MILK!!!' }, stdout: 'adding\n', stderr: '', durationMs: (reply as { durationMs: number }).durationMs })
  // An optional argument passed as undefined is left out.
  assert.deepEqual(calls.at(-1), { service: 'notes', function: 'addNote', args: ['milk'] })
})

test('a module imports a service through the same binding', async () => {
  const note = await value('import { addLoudNote } from "loud-notes"\nexport async function main() { return await addLoudNote("milk") }')
  assert.deepEqual(note, { id: 7, text: 'MILK' })
  assert.deepEqual(calls.at(-1), { service: 'notes', function: 'addNote', args: ['MILK'] })
})

test('bytes are a Uint8Array in the program and base64 on the wire', async () => {
  const reversed = await value([
    'import { reverse } from "@svc/blobs"',
    'export async function main() {',
    '  const bytes = await reverse(new Uint8Array([1, 2, 3]))',
    '  return { bytes: bytes instanceof Uint8Array, values: [...bytes] }',
    '}',
  ].join('\n'))
  assert.deepEqual(reversed, { bytes: true, values: [3, 2, 1] })
  assert.deepEqual(calls.at(-1), { service: 'blobs', function: 'reverse', args: ['AQID'] })
  // What the manifest does not declare never reaches the socket.
  const refused = await runner({ command: 'execute', ...packages(), cwd: dir, timeoutMs: 60_000, source: 'import { reverse } from "@svc/blobs"\nexport async function main() { await reverse("AQID" as never) }' })
  assert.ok(!refused.ok)
  assert.match(refused.error.message, /blobs\.reverse: data: must be bytes/u)
})

test('the packages a program may import are listed where they are', async () => {
  const reply = await runner({ command: 'modules', ...packages() })
  assert.ok(reply.ok && 'modules' in reply)
  assert.deepEqual(reply.modules.map(module => [module.specifier, module.packageRoot]), modules.map(module => [module.name, module.root]))
  assert.match(await readFile(join(modules[0]!.root, 'index.d.ts'), 'utf8'), /addNote\(text: string, tags\?: string\[\]\): Promise<Note>/u)
})

test('a type error, and a failing service call, come back as failures', async () => {
  const typeError = await runner({ command: 'execute', ...packages(), cwd: dir, timeoutMs: 60_000, source: 'export function main() { const n: number = "x"; return n }' })
  assert.ok(!typeError.ok)
  assert.equal(typeError.error.name, 'TypeCheckError')
  assert.ok((typeError.error.diagnostics?.length ?? 0) > 0)
  const failed = await runner({ command: 'execute', ...packages(), cwd: dir, timeoutMs: 60_000, source: 'import { fail } from "@svc/notes"\nexport async function main() { await fail() }' })
  assert.ok(!failed.ok)
  assert.match(failed.error.message, /disk full/u)
})

test('a program past its time, or whose call is cancelled, is killed and reported', async () => {
  const forever = 'export async function main() { await new Promise(resolve => setTimeout(resolve, 600_000)) }'
  const timedOut = await runner({ command: 'execute', ...packages(), cwd: dir, timeoutMs: 3000, source: forever })
  assert.ok(!timedOut.ok)
  assert.equal(timedOut.error.name, 'TimeoutError')
  const started = Date.now()
  const cancelled = await runner({ command: 'execute', ...packages(), cwd: dir, timeoutMs: 600_000, source: forever }, { terminateAfterMs: 3000 })
  assert.ok(!cancelled.ok)
  assert.equal(cancelled.error.name, 'ExecutionAbortedError')
  assert.ok(Date.now() - started < 20_000)
})

test('a reply over the limit is shrunk until it fits', () => {
  const huge = { ok: true as const, value: 'v'.repeat(50_000), stdout: '\u0001'.repeat(40_000), stderr: 'e'.repeat(40_000), durationMs: 1 }
  const line = replyLine(huge, 64 * 1024)
  assert.ok(Buffer.byteLength(line) <= 64 * 1024)
  const parsed = JSON.parse(line) as { value: { truncated?: boolean }; stdout: string }
  assert.equal(parsed.value.truncated, true)
  assert.match(parsed.stdout, /truncated/u)
})
