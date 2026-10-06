import assert from 'node:assert/strict'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SOCKET_VARIABLE } from '../layout.ts'
import { EXECUTABLE_NOT_FOUND, PROTOCOL_VERSION, type HelperMessage, type HostMessage } from './protocol.ts'

/** A helper on this machine, with a call socket of its own. */
function helperProcess(): ChildProcessByStdio<Writable, Readable, null> {
  const env = { ...process.env, [SOCKET_VARIABLE]: join(tmpdir(), `fleet-calls-${randomUUID()}.sock`) }
  return spawn(process.execPath, [fileURLToPath(new URL('./main.js', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'], env })
}

/** Send requests to a helper on this machine and collect what it sends until it exits, by request unless `sorted` is false. */
async function exchange(requests: HostMessage[], { sorted = true } = {}): Promise<HelperMessage[]> {
  const child = helperProcess()
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
    { type: 'result', id: 1, value: { protocol: PROTOCOL_VERSION, methods: (answers[0] as { value: { methods: string[] } }).value.methods } },
    { type: 'result', id: 2, value: { text: 'hi' } },
    { type: 'error', id: 3, message: 'echo takes a text' },
    { type: 'error', id: 4, message: 'unknown method toString' },
  ])
  const { methods } = (answers[0] as { value: { methods: string[] } }).value
  for (const method of ['hello', 'exec', 'fs.resolve', 'spawn', 'terminal', 'terminal.end']) assert.ok(methods.includes(method), method)
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
  const child = helperProcess()
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

/** A helper on this machine that can be talked to while it runs. */
function live(t: { after(fn: () => Promise<void>): void }): { send(message: HostMessage): void; answers: HelperMessage[]; until(found: () => boolean): Promise<void> } {
  const child = helperProcess()
  t.after(async () => {
    child.stdin.end()
    await once(child, 'close')
  })
  const answers: HelperMessage[] = []
  createInterface({ input: child.stdout }).on('line', (line) => { answers.push(JSON.parse(line) as HelperMessage) })
  return {
    send: (message) => { child.stdin.write(`${JSON.stringify(message)}\n`) },
    answers,
    until: async (found) => { while (!found()) await new Promise(resolve => setTimeout(resolve, 20)) },
  }
}

test('the helper watches a folder until it is told to stop', async (t) => {
  const dir = await folder(t)
  const helper = live(t)
  helper.send({ type: 'request', id: 1, method: 'fs.watch', params: { watch: 'w1', target: { targetKey: dir, displayPath: dir } } })
  // A change is reported once the watch is up, so keep changing until one is.
  for (let n = 0; !helper.answers.some(answer => answer.type === 'event' && answer.id === 1); n++) {
    await writeFile(join(dir, `f${n}.txt`), 'x')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.deepEqual(helper.answers.find(answer => answer.type === 'event'), { type: 'event', id: 1, value: { error: null } })
  helper.send({ type: 'request', id: 2, method: 'fs.unwatch', params: { watch: 'w1' } })
  await helper.until(() => helper.answers.some(answer => answer.type === 'result' && answer.id === 1))
  assert.ok(helper.answers.some(answer => answer.type === 'result' && answer.id === 2))
})

test('the helper runs a terminal: input, size, foreground group, activity, and an end that takes background jobs too', async (t) => {
  const dir = await folder(t)
  const helper = live(t)
  const output = (): string => helper.answers
    .filter(answer => answer.type === 'event' && answer.id === 1 && (answer.value as { kind: string }).kind === 'data')
    .map(answer => Buffer.from(((answer as { value: unknown }).value as { data: string }).data, 'base64').toString()).join('')
  helper.send({
    type: 'request', id: 1, method: 'terminal',
    params: { terminal: 't1', argv: ['sh'], cwd: dir, env: { PS1: '$ ' }, cols: 80, rows: 24, term: 'xterm-256color', graceMs: 500 },
  })
  await helper.until(() => helper.answers.some(answer => answer.type === 'event' && answer.id === 1))
  const started = (helper.answers.find(answer => answer.type === 'event' && answer.id === 1) as { value: { kind: string; pid: number } }).value
  assert.equal(started.kind, 'started')
  helper.send({ type: 'request', id: 2, method: 'terminal.resize', params: { terminal: 't1', cols: 100, rows: 30 } })
  helper.send({ type: 'request', id: 3, method: 'terminal.write', params: { terminal: 't1', data: 'stty size; echo $TERM; pwd\n' } })
  await helper.until(() => output().includes(dir))
  assert.match(output(), /30 100/u)
  assert.match(output(), /xterm-256color/u)
  helper.send({ type: 'request', id: 4, method: 'terminal.foreground', params: { terminal: 't1' } })
  await helper.until(() => helper.answers.some(answer => answer.id === 4))
  assert.deepEqual(helper.answers.find(answer => answer.id === 4), { type: 'result', id: 4, value: { processGroupId: started.pid } })
  // The shell alone, waiting at its prompt, is idle.
  const activity = async (id: number): Promise<unknown> => {
    helper.send({ type: 'request', id, method: 'terminal.activity', params: { terminal: 't1' } })
    await helper.until(() => helper.answers.some(answer => answer.id === id))
    return (helper.answers.find(answer => answer.id === id) as { value: unknown }).value
  }
  assert.deepEqual(await activity(10), { idle: true })
  // What runs in the foreground is not.
  helper.send({ type: 'request', id: 11, method: 'terminal.write', params: { terminal: 't1', data: 'sleep 1\n' } })
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.deepEqual(await activity(12), { idle: false })
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.deepEqual(await activity(13), { idle: true })
  // A job left behind, in a group of its own, is still the terminal's, and keeps it busy.
  helper.send({ type: 'request', id: 5, method: 'terminal.write', params: { terminal: 't1', data: 'sleep 300 &\n' } })
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.deepEqual(await activity(14), { idle: false })
  helper.send({ type: 'request', id: 6, method: 'terminal.end', params: { terminal: 't1' } })
  await helper.until(() => helper.answers.some(answer => answer.id === 6))
  assert.deepEqual(helper.answers.find(answer => answer.id === 6), { type: 'result', id: 6, value: null })
  assert.ok(helper.answers.some(answer => answer.type === 'result' && answer.id === 1))
  assert.deepEqual(await activity(15), { idle: true })
  const { stdout } = await new Promise<{ stdout: string }>((resolve) => {
    const ps = spawn('ps', ['-eo', 'sid,args'])
    let text = ''
    ps.stdout.on('data', (chunk: Buffer) => { text += chunk.toString() })
    ps.on('close', () => { resolve({ stdout: text }) })
  })
  assert.ok(!stdout.split('\n').some(line => line.trim().startsWith(`${started.pid} `)), 'no process of the terminal\'s session is left')
})

test('the helper links a tau\'s APIs to their clients, and its exposed packages, for code anywhere below', async (t) => {
  const dir = await folder(t)
  await mkdir(join(dir, 'tau/self/api/notes'), { recursive: true })
  await writeFile(join(dir, 'tau/self/api/notes/index.d.ts'), 'export declare function hello(): string;\n')
  await mkdir(join(dir, 'tau/self/node_modules/wrap'), { recursive: true })
  await writeFile(join(dir, 'tau/self/node_modules/wrap/package.json'), JSON.stringify({ name: 'wrap', type: 'module', exports: './index.js' }))
  await writeFile(join(dir, 'tau/self/node_modules/wrap/index.js'), 'import { hello } from "@api/notes"; export const loud = () => hello().toUpperCase();\n')
  await mkdir(join(dir, 'client'))
  await writeFile(join(dir, 'client/index.js'), 'export const hello = () => "hi"; export default "whole";\n')
  await mkdir(join(dir, 'tau/scratch'))
  // TypeScript, which Node runs as is.
  await writeFile(join(dir, 'tau/scratch/main.ts'), [
    'import notes, { hello } from "@api/notes";',
    'import { loud } from "wrap";',
    'const said: string[] = [hello(), notes, loud()];',
    'process.stdout.write(JSON.stringify(said));',
  ].join('\n'))
  const answers = await exchange([
    {
      type: 'request', id: 1, method: 'apis.link', params: {
        modules: join(dir, 'tau/node_modules'),
        apis: [{ name: 'notes', client: join(dir, 'client'), types: join(dir, 'tau/self/api/notes') }],
        packages: [{ name: 'wrap', dir: join(dir, 'tau/self/node_modules/wrap') }],
      },
    },
    { type: 'request', id: 2, method: 'exec', params: { argv: [process.execPath, join(dir, 'tau/scratch/main.ts')] } },
    { type: 'request', id: 3, method: 'apis.link', params: { modules: 'relative', apis: [], packages: [] } },
  ], { sorted: false })
  assert.deepEqual(answers.find(answer => answer.id === 1), { type: 'result', id: 1, value: null })
  assert.deepEqual((answers.find(answer => answer.id === 2) as { value: { stdout: string } }).value.stdout, '["hi","whole","HI"]')
  assert.deepEqual(answers.find(answer => answer.id === 3), { type: 'error', id: 3, message: 'apis.link takes modules, an absolute path' })
  const manifest = JSON.parse(await readFile(join(dir, 'tau/node_modules/@api/notes/package.json'), 'utf8')) as { exports: object }
  assert.deepEqual(manifest.exports, { '.': { types: './api/index.d.ts', default: './index.js' } })
  assert.equal(await readFile(join(dir, 'tau/node_modules/@api/notes/api/index.d.ts'), 'utf8'), 'export declare function hello(): string;\n')
})

test('the helper relays a client\'s calls to the host, their answers back, and a caller gone as a cancel', async (t) => {
  const helper = live(t)
  const client = JSON.stringify(pathToFileURL(fileURLToPath(new URL('../ext/client.js', import.meta.url))).href)
  const program = (code: string): string[] => [process.execPath, '--input-type=module', '--eval', `import { call } from ${client};\n${code}`]
  const calls = (): Extract<HelperMessage, { type: 'call' }>[] => helper.answers.filter(answer => answer.type === 'call')
  helper.send({
    type: 'request', id: 1, method: 'exec',
    params: { argv: program('const got = await call("notes", "add", ["milk", undefined]); const failed = await call("notes", "nope", []).catch(error => error.message); process.stdout.write(JSON.stringify([got, failed]))') },
  })
  await helper.until(() => calls().length === 1)
  assert.deepEqual(calls()[0], { type: 'call', id: calls()[0]?.id, api: 'notes', method: 'add', args: ['milk'] })
  helper.send({ type: 'call-result', id: calls()[0]?.id ?? 0, value: { id: 1 } })
  await helper.until(() => calls().length === 2)
  helper.send({ type: 'call-error', id: calls()[1]?.id ?? 0, message: 'no method nope' })
  await helper.until(() => helper.answers.some(answer => answer.type === 'result' && answer.id === 1))
  assert.equal((helper.answers.find(answer => answer.type === 'result' && answer.id === 1) as { value: { stdout: string } }).value.stdout, '[{"id":1},"notes.nope: no method nope"]')

  helper.send({
    type: 'request', id: 2, method: 'exec',
    params: { argv: program('await call("notes", "slow", [], AbortSignal.timeout(100)).catch(() => {})') },
  })
  await helper.until(() => calls().length === 3)
  const slow = calls()[2]?.id
  await helper.until(() => helper.answers.some(answer => answer.type === 'call-cancel' && answer.id === slow))
  // Its answer, late, goes nowhere.
  helper.send({ type: 'call-result', id: slow ?? 0, value: null })
  await helper.until(() => helper.answers.some(answer => answer.type === 'result' && answer.id === 2))
})

test('the helper relays the bytes after a client\'s call to the host, and after the host\'s answer back', async (t) => {
  const helper = live(t)
  const client = JSON.stringify(pathToFileURL(fileURLToPath(new URL('../ext/client.js', import.meta.url))).href)
  const program = (code: string): string[] => [process.execPath, '--input-type=module', '--eval', `import { callStream } from ${client};\n${code}`]
  const sent = (type: string) => helper.answers.filter(answer => answer.type === type) as { id: number; data?: string; body?: true }[]
  helper.send({
    type: 'request', id: 1, method: 'exec',
    params: {
      argv: program([
        'async function* up() { for (let i = 0; i < 50; i++) yield Buffer.alloc(10000, "u") }',
        'const { value, body } = await callStream("tau", "start", ["x"], { body: up() })',
        'let down = ""; for await (const chunk of body) down += chunk',
        'const plain = await callStream("tau", "status", [])',
        'let none = ""; for await (const chunk of plain.body) none += chunk',
        'process.stdout.write(JSON.stringify([value, down, plain.value, none]))',
      ].join(';\n')),
    },
  })
  await helper.until(() => sent('call-end').length === 1)
  const [call] = sent('call')
  assert.deepEqual(call, { type: 'call', id: call?.id, api: 'tau', method: 'start', args: ['x'], body: true })
  const up = Buffer.concat(sent('call-data').map(data => Buffer.from(data.data ?? '', 'base64')))
  assert.equal(up.length, 500000)
  assert.ok(up.every(byte => byte === 0x75))
  const id = call?.id ?? 0
  helper.send({ type: 'call-result', id, value: 'started', body: true })
  helper.send({ type: 'call-data', id, data: Buffer.from('down ').toString('base64') })
  helper.send({ type: 'call-data', id, data: Buffer.from('here').toString('base64') })
  helper.send({ type: 'call-end', id })
  await helper.until(() => sent('call').length === 2)
  const plain = sent('call')[1]
  assert.equal(plain?.body, undefined)
  helper.send({ type: 'call-result', id: plain?.id ?? 0, value: 'running' })
  await helper.until(() => helper.answers.some(answer => answer.type === 'result' && answer.id === 1))
  assert.equal((helper.answers.find(answer => answer.type === 'result' && answer.id === 1) as { value: { stdout: string } }).value.stdout, '["started","down here","running",""]')
})
