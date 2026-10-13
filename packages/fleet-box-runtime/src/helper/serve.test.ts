import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { SOCKET_VARIABLE } from '../layout.ts'
import type { HelperMessage, HostMessage } from './protocol.ts'
import { serve } from './serve.ts'

/** Serve `requests` in this process, with the environment and folder given, and collect the answers, by request. */
async function served(requests: HostMessage[], env: Record<string, string | undefined>, cwd: string): Promise<{ answers: HelperMessage[]; logged: string[] }> {
  const input = new PassThrough()
  const output = new PassThrough()
  const logged: string[] = []
  let text = ''
  output.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
  const serving = serve({ input, output, env, cwd, log: message => logged.push(message) })
  for (const request of requests) input.write(`${JSON.stringify(request)}\n`)
  input.write('not json\n')
  input.end()
  await serving
  const answers = text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as HelperMessage)
  return { answers: answers.sort((a, b) => a.id - b.id), logged }
}

test('a helper serves in the environment and folder it is given, and names its call socket there, not in its process\'s', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'fleet-serve-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  await writeFile(join(work, 'here.txt'), 'here\n')
  const socket = join(tmpdir(), `fleet-calls-${randomUUID()}.sock`)
  const env: Record<string, string | undefined> = { PATH: process.env.PATH, ONLY_HERE: 'yes', [SOCKET_VARIABLE]: socket }
  const before = process.env[SOCKET_VARIABLE]
  const { answers, logged } = await served([
    { type: 'request', id: 1, method: 'echo', params: { text: 'hi' } },
    { type: 'request', id: 2, method: 'fs.resolve', params: { path: 'here.txt' } },
    { type: 'request', id: 3, method: 'spawn', params: {
      process: 'p', argv: ['sh', '-c', 'printf "%s %s" "$ONLY_HERE" "$FLEET_SOCKET"'], cwd: work, env: {}, stdin: null, graceMs: 1000,
    } },
  ], env, work)
  assert.deepEqual(answers.find(answer => answer.id === 1), { type: 'result', id: 1, value: { text: 'hi' } })
  assert.deepEqual(answers.find(answer => answer.id === 2 && answer.type === 'result'), { type: 'result', id: 2, value: { targetKey: join(work, 'here.txt'), displayPath: join(work, 'here.txt') } })
  const written = answers.filter(answer => answer.id === 3 && answer.type === 'event')
    .map(answer => Buffer.from((answer as { value: { data: string } }).value.data, 'base64').toString('utf8')).join('')
  assert.equal(written, `yes ${socket}`)
  assert.deepEqual(answers.find(answer => answer.id === 3 && answer.type === 'result'), { type: 'result', id: 3, value: { code: 0, signal: null } })
  assert.equal(process.env[SOCKET_VARIABLE], before)
  assert.deepEqual(logged, ['unreadable message'])
})
