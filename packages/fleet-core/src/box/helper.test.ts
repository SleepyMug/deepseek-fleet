import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Helper, HelperError } from './helper.ts'

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

test('a helper that answers with the wrong shape loses its connection', async () => {
  await assert.rejects(Helper.start(fake({ type: 'result', value: { protocol: 'one' } })), /unexpected value/u)
  await assert.rejects(Helper.start(fake({ type: 'nonsense' })), /broke the protocol/u)
})

test('a helper that fails to start says why', async () => {
  await assert.rejects(Helper.start([process.execPath, '--eval', 'console.error("no such container"); process.exit(1)']), /exited: no such container/u)
})
