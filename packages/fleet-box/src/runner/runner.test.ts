import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { RunnerReply, RunnerRequest, ServiceModule } from './protocol.ts'
import { replyLine } from './report.ts'

const RUNNER = fileURLToPath(new URL('./main.js', import.meta.url))

let dir: string
let socketPath: string
let server: Server
const calls: unknown[] = []

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-box-runner-'))
  socketPath = join(dir, 'tau.sock')
  // A provider as the host's relay answers: one line in, one line out.
  server = createServer((socket) => {
    let line = ''
    socket.on('data', (chunk: Buffer) => {
      line += chunk.toString('utf8')
      if (!line.includes('\n')) return
      const call = JSON.parse(line) as { function: string; args: unknown[] }
      calls.push(call)
      socket.end(`${JSON.stringify(call.function === 'fail' ? { error: { message: 'disk full' } } : { result: { id: 7, text: call.args[0] } })}\n`)
    })
  })
  await new Promise<void>((resolve) => { server.listen(socketPath, resolve) })
  // An agent module.
  await mkdir(join(dir, 'modules', 'shout'), { recursive: true })
  await writeFile(join(dir, 'modules', 'shout', 'package.json'), JSON.stringify({ name: 'shout', description: 'Loud text.', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }))
  await writeFile(join(dir, 'modules', 'shout', 'index.js'), 'export function shout(text) { return `${text.toUpperCase()}!!!` }\n')
  await writeFile(join(dir, 'modules', 'shout', 'index.d.ts'), 'export declare function shout(text: string): string;\n')
})

after(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

const notes: ServiceModule = {
  name: 'notes',
  declarations: 'export interface Note { id: number; text: string }\nexport declare function addNote(text: string): Promise<Note>;\nexport declare function fail(): Promise<void>;\n',
  functions: ['addNote', 'fail'],
}

function packages() {
  return { root: join(dir, 'root'), services: [notes], modules: [{ name: 'shout', root: join(dir, 'modules', 'shout') }] }
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

test('a program imports its services and the agent\'s modules, and returns JSON', async () => {
  const reply = await runner({
    command: 'execute', ...packages(), cwd: dir, timeoutMs: 60_000, input: { text: 'milk' },
    source: [
      'import { addNote } from "@svc/notes"',
      'import { shout } from "shout"',
      'export async function main(input: { text: string }) {',
      '  console.log("adding")',
      '  const note = await addNote(input.text)',
      '  return { note, loud: shout(note.text) }',
      '}',
    ].join('\n'),
  })
  assert.deepEqual(reply, { ok: true, value: { note: { id: 7, text: 'milk' }, loud: 'MILK!!!' }, stdout: 'adding\n', stderr: '', durationMs: (reply as { durationMs: number }).durationMs })
  assert.deepEqual(calls.at(-1), { service: 'notes', function: 'addNote', args: ['milk'] })
})

test('the packages a program may import are listed', async () => {
  const reply = await runner({ command: 'modules', ...packages() })
  assert.ok(reply.ok && 'modules' in reply)
  assert.deepEqual(reply.modules.map(module => module.specifier), ['@svc/notes', 'shout'])
  // A service's package stays readable after the run, unlike the one ts-executor wrote for it.
  const notesRoot = reply.modules.find(module => module.specifier === '@svc/notes')?.packageRoot
  assert.equal(notesRoot, join(dir, 'root', 'svc', 'notes'))
  assert.equal(await readFile(join(notesRoot, 'index.d.ts'), 'utf8'), notes.declarations)
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
