import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from 'fleet-box-runtime/helper/protocol'
import { SOCKET_VARIABLE } from 'fleet-box-runtime/layout'
import { Helper, HelperError, METHODS, streamed } from './helper.ts'

/** The helper as built on this machine, run on this Node. */
const LOCAL_HELPER = [
  process.execPath,
  join(dirname(fileURLToPath(import.meta.resolve('fleet-box-runtime/package.json'))), 'lib/helper/main.js'),
] as const

/** A stand-in that answers every line it reads with `answer`. */
function fake(answer: object): readonly [string, ...string[]] {
  const code = `require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    console.log(JSON.stringify({ id: JSON.parse(line).id, ...${JSON.stringify(answer)} }))
  })`
  return [process.execPath, '--eval', code]
}

test('a helper answers requests until it is closed', async () => {
  const helper = await Helper.start(LOCAL_HELPER)
  assert.deepEqual(await helper.request('echo', { text: 'hi' }), { text: 'hi' })
  await assert.rejects(helper.request('echo', { text: 1 as unknown as string }), new HelperError('echo takes a text'))
  await assert.rejects(helper.request('toString' as 'echo', { text: 'hi' }), /no method toString/u)
  await helper.close()
  await assert.rejects(helper.request('echo', { text: 'hi' }), /connection is closed/u)
})

test('a helper that speaks another protocol is refused', async () => {
  await assert.rejects(Helper.start(fake({ type: 'result', value: { protocol: 0 } })), /speaks protocol 0/u)
})

test('a helper from an older image, which lacks methods, is refused', async () => {
  await assert.rejects(Helper.start(fake({ type: 'result', value: { protocol: PROTOCOL_VERSION } })), /does not list its methods: its box was made from an older image/u)
  await assert.rejects(
    Helper.start(fake({ type: 'result', value: { protocol: PROTOCOL_VERSION, methods: METHODS.filter(method => method !== 'which') } })),
    /serves no which: its box was made from an older image/u,
  )
})

test('a helper that answers with the wrong shape loses its connection', async () => {
  await assert.rejects(Helper.start(fake({ type: 'result', value: { protocol: 'one' } })), /unexpected value/u)
  await assert.rejects(Helper.start(fake({ type: 'nonsense' })), /broke the protocol/u)
})

test('a helper that fails to start says why', async () => {
  await assert.rejects(Helper.start([process.execPath, '--eval', 'console.error("no such container"); process.exit(1)']), /exited: no such container/u)
})

test('a helper sends a request\'s events before its result, and a failure\'s code', async () => {
  const helper = await Helper.start(LOCAL_HELPER)
  try {
    const output: string[] = []
    const ended = await helper.request('spawn', {
      process: 'p1', argv: ['sh', '-c', 'printf one; printf two >&2'], cwd: '/', env: {}, stdin: null, graceMs: 1000,
    }, (event) => { output.push(`${event.stream}:${Buffer.from(event.data, 'base64').toString()}`) })
    assert.deepEqual(ended, { code: 0, signal: null })
    assert.deepEqual(output.sort(), ['stderr:two', 'stdout:one'])
    await assert.rejects(helper.request('which', { command: 'no-such-program', env: null }), { name: 'HelperError', code: 'EXECUTABLE_NOT_FOUND' })
  } finally {
    await helper.close()
  }
})

test('a helper that sends an unexpected event loses its connection', async () => {
  const code = `require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, method } = JSON.parse(line)
    if (method === 'hello') console.log(JSON.stringify({ type: 'result', id, value: { protocol: ${PROTOCOL_VERSION}, methods: ${JSON.stringify(METHODS)} } }))
    else console.log(JSON.stringify({ type: 'event', id, value: { stream: 'elsewhere', data: '' } }))
  })`
  const helper = await Helper.start([process.execPath, '--eval', code])
  await assert.rejects(helper.request('echo', { text: 'hi' }), /unexpected event/u)
  await helper.close()
})

test('a call\'s bytes reach its handler, and the bytes after its answer reach the client, through the helper', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-helper-calls-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const socket = process.env[SOCKET_VARIABLE]
  process.env[SOCKET_VARIABLE] = join(dir, 'calls.sock')
  t.after(() => { if (socket === undefined) delete process.env[SOCKET_VARIABLE]; else process.env[SOCKET_VARIABLE] = socket })
  const got: string[] = []
  const helper = await Helper.start(LOCAL_HELPER, async (call, _signal, body) => {
    let size = 0
    for await (const chunk of body ?? []) size += (chunk as Uint8Array).length
    got.push(`${call.api}.${call.method} ${JSON.stringify(call.args)} ${String(size)}`)
    if (call.method === 'plain') return 'plain'
    if (call.method === 'broken') {
      return streamed('cut', (async function* () {
        yield Buffer.from('partial')
        throw new Error('the archive went away')
      })())
    }
    return streamed({ size }, (async function* () {
      for (let index = 0; index < 30; index++) yield Buffer.alloc(10000, 'd')
    })())
  })
  try {
    const client = JSON.stringify(import.meta.resolve('fleet-box-runtime/ext/client'))
    const program = [
      `import { callStream } from ${client}`,
      'async function* up() { for (let i = 0; i < 20; i++) yield Buffer.alloc(10000, "u") }',
      'const read = async ({ value, body }) => { let size = 0; for await (const chunk of body) size += chunk.length; return [value, size] }',
      'const out = [await read(await callStream("tau", "start", ["x"], { body: up() })), await read(await callStream("tau", "plain", []))]',
      'out.push(await read(await callStream("tau", "broken", [])))',
      'process.stdout.write(JSON.stringify(out))',
    ].join('\n')
    const ran = await helper.request('exec', { argv: [process.execPath, '--input-type=module', '--eval', program] })
    assert.equal(ran.stderr, '')
    assert.deepEqual(JSON.parse(ran.stdout), [[{ size: 200000 }, 300000], ['plain', 0], ['cut', 7]])
    assert.deepEqual(got, ['tau.start ["x"] 200000', 'tau.plain [] 0', 'tau.broken [] 0'])
  } finally {
    await helper.close()
  }
})
