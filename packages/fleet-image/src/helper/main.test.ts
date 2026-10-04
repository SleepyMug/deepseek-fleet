import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { EXECUTABLE_NOT_FOUND, PROTOCOL_VERSION, type HelperMessage, type HostMessage } from './protocol.ts'

/** Send requests to a helper on this machine and collect what it sends until it exits, by request unless `sorted` is false. */
async function exchange(requests: HostMessage[], { sorted = true } = {}): Promise<HelperMessage[]> {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./main.js', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] })
  const answers: HelperMessage[] = []
  createInterface({ input: child.stdout }).on('line', (line) => { answers.push(JSON.parse(line) as HelperMessage) })
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`)
  child.stdin.end()
  const [code] = await once(child, 'close') as [number | null]
  assert.equal(code, 0)
  return sorted ? answers.sort((a, b) => a.id - b.id) : answers
}

test('the helper answers each request, and exits once its stdin ends', async () => {
  const answers = await exchange([
    { type: 'request', id: 1, method: 'hello', params: {} },
    { type: 'request', id: 2, method: 'echo', params: { text: 'hi' } },
    { type: 'request', id: 3, method: 'echo', params: {} },
    { type: 'request', id: 4, method: 'toString', params: {} },
  ])
  assert.deepEqual(answers, [
    { type: 'result', id: 1, value: { protocol: PROTOCOL_VERSION } },
    { type: 'result', id: 2, value: { text: 'hi' } },
    { type: 'error', id: 3, message: 'echo takes a text' },
    { type: 'error', id: 4, message: 'unknown method toString' },
  ])
})

test('the helper runs programs, and answers how they ended', async () => {
  const program = (code: string): string[] => [process.execPath, '--eval', code]
  const answers = await exchange([
    { type: 'request', id: 1, method: 'exec', params: { argv: program('process.stdout.write("out"); process.stderr.write("err")') } },
    { type: 'request', id: 2, method: 'exec', params: { argv: program('process.exit(3)') } },
    { type: 'request', id: 3, method: 'exec', params: { argv: program('process.kill(process.pid, "SIGKILL")') } },
    { type: 'request', id: 4, method: 'exec', params: { argv: ['/no/such/program'] } },
    { type: 'request', id: 5, method: 'exec', params: { argv: [] } },
  ])
  assert.deepEqual(answers.slice(0, 3), [
    { type: 'result', id: 1, value: { code: 0, signal: null, stdout: 'out', stderr: 'err' } },
    { type: 'result', id: 2, value: { code: 3, signal: null, stdout: '', stderr: '' } },
    { type: 'result', id: 3, value: { code: null, signal: 'SIGKILL', stdout: '', stderr: '' } },
  ])
  assert.match((answers[3] as { message: string }).message, /^exec cannot run \/no\/such\/program: .*ENOENT/u)
  assert.deepEqual(answers[4], { type: 'error', id: 5, message: 'exec takes an argv, a list of strings, the program first' })
})

/** A folder of the test's own, removed after it. */
async function folder(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fleet-helper-test-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('the helper serves dsh\'s file system, and keeps an FsError\'s code', async (t) => {
  const dir = await folder(t)
  await writeFile(join(dir, 'a.txt'), 'one two\n')
  const file = { targetKey: join(dir, 'a.txt'), displayPath: join(dir, 'a.txt') }
  const answers = await exchange([
    { type: 'request', id: 1, method: 'fs.resolve', params: { path: 'a.txt', cwd: dir } },
    { type: 'request', id: 2, method: 'fs.readText', params: { target: file } },
    { type: 'request', id: 3, method: 'fs.stat', params: { target: { targetKey: join(dir, 'none'), displayPath: 'none' } } },
    { type: 'request', id: 4, method: 'fs.readText', params: { target: { targetKey: join(dir, 'none'), displayPath: 'none' } } },
    { type: 'request', id: 5, method: 'fs.listDir', params: { target: { targetKey: dir, displayPath: dir } } },
    { type: 'request', id: 6, method: 'fs.readRange', params: { target: file, offset: 4, length: 3 } },
  ])
  assert.deepEqual(answers[0], { type: 'result', id: 1, value: file })
  assert.deepEqual(answers[1], { type: 'result', id: 2, value: 'one two\n' })
  assert.deepEqual(answers[2], { type: 'result', id: 3, value: null })
  assert.equal(answers[3]?.type, 'error')
  assert.equal((answers[3] as { code?: string }).code, 'FS_NOT_FOUND')
  const [entry] = (answers[4] as { value: Array<{ name: string; type: string; target: unknown }> }).value
  assert.deepEqual([entry?.name, entry?.type, entry?.target], ['a.txt', 'file', file])
  assert.equal(Buffer.from((answers[5] as { value: string }).value, 'base64').toString(), 'two')
})

test('the helper writes and edits through dsh\'s file system', async (t) => {
  const dir = await folder(t)
  const file = { targetKey: join(dir, 'b.txt'), displayPath: join(dir, 'b.txt') }
  const answers = await exchange([
    { type: 'request', id: 1, method: 'fs.writeText', params: { target: file, content: 'hello world\n', expected: { kind: 'createIfAbsent' } } },
  ])
  assert.equal((answers[0] as { value: { operation: string } }).value.operation, 'create')
  const edited = await exchange([
    { type: 'request', id: 1, method: 'fs.editText', params: { target: file, edit: { oldString: 'world', newString: 'box', replaceAll: false } } },
  ])
  assert.equal((edited[0] as { value: { after: string } }).value.after, 'hello box\n')
  assert.equal(await readFile(file.targetKey, 'utf8'), 'hello box\n')
})

test('the helper runs a process, sends its output as events, and answers how it ended', async (t) => {
  const dir = await folder(t)
  const answers = await exchange([
    {
      type: 'request', id: 1, method: 'spawn',
      params: { process: 'p1', argv: ['sh', '-c', 'pwd; printf "$GREETING"; cat; printf oops >&2; exit 4'], cwd: dir, env: { GREETING: 'hi ' }, stdin: 'in', graceMs: 1000 },
    },
    { type: 'request', id: 2, method: 'spawn', params: { process: 'p2', argv: ['true'], cwd: join(dir, 'none'), env: {}, stdin: null, graceMs: 1000 } },
  ], { sorted: false })
  const events = answers.filter(answer => answer.type === 'event' && answer.id === 1) as Array<{ value: { stream: string; data: string } }>
  const text = (stream: string): string => events.filter(event => event.value.stream === stream).map(event => Buffer.from(event.value.data, 'base64').toString()).join('')
  assert.equal(text('stdout'), `${dir}\nhi in`)
  assert.equal(text('stderr'), 'oops')
  assert.deepEqual(answers.find(answer => answer.type === 'result' && answer.id === 1), { type: 'result', id: 1, value: { code: 4, signal: null } })
  assert.match((answers.find(answer => answer.id === 2) as { message: string }).message, /working folder .* does not exist in the box/u)
})

test('the helper kills a process\'s group, and its exit ends the processes it started', async (t) => {
  const dir = await folder(t)
  const child = spawn(process.execPath, [fileURLToPath(new URL('./main.js', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] })
  const answers: HelperMessage[] = []
  createInterface({ input: child.stdout }).on('line', (line) => { answers.push(JSON.parse(line) as HelperMessage) })
  const send = (message: HostMessage): void => { child.stdin.write(`${JSON.stringify(message)}\n`) }
  const until = async (found: () => boolean): Promise<void> => { while (!found()) await new Promise(resolve => setTimeout(resolve, 20)) }
  // The shell traps SIGTERM away, so only the SIGKILL after the grace period ends it.
  send({ type: 'request', id: 1, method: 'spawn', params: { process: 'p1', argv: ['sh', '-c', 'trap "" TERM; echo up; sleep 30 & wait'], cwd: dir, env: {}, stdin: null, graceMs: 200 } })
  await until(() => answers.some(answer => answer.type === 'event'))
  send({ type: 'request', id: 2, method: 'kill', params: { process: 'p1' } })
  await until(() => answers.some(answer => answer.type === 'result' && answer.id === 1))
  assert.deepEqual(answers.find(answer => answer.type === 'result' && answer.id === 1), { type: 'result', id: 1, value: { code: null, signal: 'SIGKILL' } })

  send({ type: 'request', id: 3, method: 'spawn', params: { process: 'p2', argv: ['sh', '-c', 'echo up; exec sleep 30'], cwd: dir, env: {}, stdin: null, graceMs: 200 } })
  await until(() => answers.some(answer => answer.type === 'event' && answer.id === 3))
  child.stdin.end()
  const [code] = await once(child, 'close') as [number | null]
  assert.equal(code, 0)
  assert.deepEqual(answers.find(answer => answer.type === 'result' && answer.id === 3), { type: 'result', id: 3, value: { code: null, signal: 'SIGTERM' } })
})

test('the helper finds programs on the PATH, and says when one is not there', async () => {
  const answers = await exchange([
    { type: 'request', id: 1, method: 'which', params: { command: 'sh', env: null } },
    { type: 'request', id: 2, method: 'which', params: { command: 'no-such-program', env: null } },
    { type: 'request', id: 3, method: 'which', params: { command: 'sh', env: { PATH: '/nowhere' } } },
  ])
  assert.match((answers[0] as { value: string }).value, /\/sh$/u)
  assert.equal((answers[1] as { code?: string }).code, EXECUTABLE_NOT_FOUND)
  assert.equal((answers[2] as { code?: string }).code, EXECUTABLE_NOT_FOUND)
})
