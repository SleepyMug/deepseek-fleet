import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from 'fleet-image/helper/protocol'
import { Helper, HelperError, METHODS } from './helper.ts'

/** The helper as built on this machine, run on this Node. */
const LOCAL_HELPER = [
  process.execPath,
  join(dirname(fileURLToPath(import.meta.resolve('fleet-image/package.json'))), 'lib/helper/main.js'),
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
