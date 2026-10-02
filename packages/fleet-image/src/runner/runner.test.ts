import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { LinkedApi, RunnerReply, RunnerRequest } from './protocol.ts'
import { replyLine } from './report.ts'

const RUNNER = fileURLToPath(new URL('./main.js', import.meta.url))

let dir: string
let notes: LinkedApi

/** Files under `root`, by their paths relative to it. */
async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text)
  }
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-tau-runner-'))
  // The agent's API, as its snapshot has it, importing a file of its own.
  await writeFiles(join(dir, 'agent', 'api'), {
    'notes.d.ts': [
      'import type { When } from "./shared/when.js";',
      'export interface Note { id: number; text: string; written: When }',
      'export declare function addNote(text: string): Promise<Note>;',
      'export declare function fail(): Promise<void>;',
    ].join('\n'),
    'shared/when.d.ts': 'export type When = Date;\n',
  })
  // fleet's implementation, as the image has it: it may give more than the API declares.
  await writeFiles(join(dir, 'apis', 'notes'), {
    'index.js': [
      'export async function addNote(text) { return { id: 7, text, written: new Date(0) } }',
      'export async function fail() { throw new Error("disk full") }',
      'export function extra() {}',
    ].join('\n'),
    'index.d.ts': 'export declare function addNote(text: string): Promise<{ id: number; text: string; written: Date }>;\nexport declare function fail(): Promise<void>;\nexport declare function extra(): void;\n',
  })
  notes = { name: 'notes', description: 'Notes.', types: join(dir, 'agent', 'api', 'notes.d.ts'), implementation: join(dir, 'apis', 'notes', 'index.js'), exposed: true }
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

function packages() {
  return { root: join(dir, 'root'), modules: join(dir, 'node_modules'), apis: [notes], packages: [] }
}

/** Run the runner once; `terminateAfterMs` sends it SIGTERM, as the host does on a cancelled call. */
function runner(request: RunnerRequest, options: { terminateAfterMs?: number } = {}): Promise<RunnerReply> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER], { stdio: ['pipe', 'pipe', 'inherit'] })
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

const execute = (source: string, timeoutMs = 60_000, input?: unknown) =>
  runner({ command: 'execute', ...packages(), cwd: dir, timeoutMs, source, ...input === undefined ? {} : { input } })

test('a program imports an API, typed by the agent\'s declarations and run by the implementation', async () => {
  const reply = await execute([
    'import { addNote } from "@api/notes"',
    'export async function main(input: { text: string }) {',
    '  console.log("adding")',
    '  const note = await addNote(input.text)',
    '  return { id: note.id, written: note.written.toISOString(), date: note.written instanceof Date, node: typeof process.versions.node }',
    '}',
  ].join('\n'), 60_000, { text: 'milk' })
  assert.deepEqual(reply, {
    ok: true, value: { id: 7, written: '1970-01-01T00:00:00.000Z', date: true, node: 'string' }, stdout: 'adding\n', stderr: '', durationMs: (reply as { durationMs: number }).durationMs,
  })
  // The implementation gives more than the API declares; the program sees only the API.
  const extra = await execute('import { extra } from "@api/notes"\nexport function main() { extra() }')
  assert.ok(!extra.ok)
  assert.equal(extra.error.name, 'TypeCheckError')
})

test('an API\'s package is listed, reads as the agent declared it, and is shared by runs at once', async () => {
  const [first, second] = await Promise.all([runner({ command: 'modules', ...packages() }), runner({ command: 'modules', ...packages() })])
  for (const reply of [first, second]) assert.ok(reply?.ok && 'modules' in reply)
  const listed = (first as Extract<RunnerReply, { modules: unknown }>).modules
  assert.deepEqual(listed.map(({ specifier, description }) => [specifier, description]), [['@api/notes', 'Notes.']])
  const root = listed[0]!.packageRoot
  assert.equal((second as Extract<RunnerReply, { modules: unknown }>).modules[0]!.packageRoot, root)
  assert.deepEqual(await readdir(join(dir, 'root', 'apis')), [root.split('/').at(-1)])
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { exports: { '.': { types: string } } }
  assert.equal(await readFile(join(root, manifest.exports['.'].types), 'utf8'), await readFile(notes.types, 'utf8'))
})

test('an API typed by fleet\'s own declarations, beside its implementation, is linked as one the agent declared', async () => {
  // Only fleet's declarations have `extra`, so the program type-checks only against them.
  const own = { ...notes, types: join(dir, 'apis', 'notes', 'index.d.ts') }
  const reply = await runner({ command: 'execute', ...packages(), apis: [own], cwd: dir, source: 'import { extra } from "@api/notes"\nexport function main() { extra(); return "linked" }' })
  assert.deepEqual(reply, { ok: true, value: 'linked', stdout: '', stderr: '', durationMs: (reply as { durationMs: number }).durationMs })
})

test('the agent\'s own packages import the APIs from the implementations programs do, and only what it exposes is listed', async () => {
  // A package built on the notes API, laid out as pnpm installs it.
  const kit = join(dir, 'agent', 'node_modules', '.pnpm', 'notes-kit@1.0.0', 'node_modules', 'notes-kit')
  await writeFiles(kit, {
    'package.json': JSON.stringify({ name: 'notes-kit', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }),
    'index.d.ts': 'import type { Note } from "@api/notes";\nexport declare function rememberAll(texts: string[]): Promise<Note[]>;\nexport declare const add: (text: string) => Promise<Note>;\n',
    'index.js': 'import { addNote } from "@api/notes";\nexport const add = addNote;\nexport const rememberAll = (texts) => Promise.all(texts.map((text) => addNote(text)));\n',
  })
  await symlink('.pnpm/notes-kit@1.0.0/node_modules/notes-kit', join(dir, 'agent', 'node_modules', 'notes-kit'))
  const request = { ...packages(), apis: [{ ...notes, exposed: false }], packages: [{ specifier: 'notes-kit', description: 'Notes in fewer calls.', root: join(dir, 'agent', 'node_modules', 'notes-kit') }] }

  const listed = await runner({ command: 'modules', ...request })
  assert.ok(listed.ok && 'modules' in listed)
  assert.deepEqual(listed.modules.map(({ specifier, description }) => [specifier, description]), [['notes-kit', 'Notes in fewer calls.']])
  // The package's types come from the agent's declarations, so a misuse of what it returns fails the check.
  const misused = await runner({ command: 'execute', ...request, cwd: dir, source: 'import { rememberAll } from "notes-kit"\nexport async function main() { const id: string = (await rememberAll(["x"]))[0]!.id; return id }' })
  assert.ok(!misused.ok)
  assert.equal(misused.error.name, 'TypeCheckError')
  // An API the agent does not expose is not a security boundary: a program that imports it anyway gets the one implementation.
  const reply = await runner({
    command: 'execute', ...request, cwd: dir, source: [
      'import { add, rememberAll } from "notes-kit"',
      'import { addNote } from "@api/notes"',
      'export async function main() {',
      '  const notes = await rememberAll(["milk", "eggs"])',
      '  return { texts: notes.map((note) => note.text), date: notes[0]!.written instanceof Date, same: add === addNote }',
      '}',
    ].join('\n'),
  })
  assert.deepEqual(reply, { ok: true, value: { texts: ['milk', 'eggs'], date: true, same: true }, stdout: '', stderr: '', durationMs: (reply as { durationMs: number }).durationMs })
})

test('a type error, and a failing API call, come back as failures', async () => {
  const typeError = await execute('export function main() { const n: number = "x"; return n }')
  assert.ok(!typeError.ok)
  assert.equal(typeError.error.name, 'TypeCheckError')
  assert.ok((typeError.error.diagnostics?.length ?? 0) > 0)
  const failed = await execute('import { fail } from "@api/notes"\nexport async function main() { await fail() }')
  assert.ok(!failed.ok)
  assert.match(failed.error.message, /disk full/u)
})

test('a program past its time, or whose call is cancelled, is killed and reported', async () => {
  const forever = 'export async function main() { await new Promise(resolve => setTimeout(resolve, 600_000)) }'
  const timedOut = await execute(forever, 3000)
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
