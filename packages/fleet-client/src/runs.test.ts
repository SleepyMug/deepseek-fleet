import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { test } from 'node:test'
import { writeResult } from '@sleepymug/tau/call'
import { finishRun } from './runs.ts'

test('a finish writes the run\'s session\'s history where it is asked to, one event per line, failed or not', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-client-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'tau.sock')
  const received: unknown[] = []
  const history = [{ type: 'user/message', data: { text: 'Go.\nNow.' } }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } }]
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.once('data', (line: string) => {
      const request = JSON.parse(line) as { history?: boolean }
      received.push(request.history)
      const failed = { ok: false, text: '', failure: 'the run was cancelled' }
      socket.write(`${JSON.stringify({ ok: true, value: { result: failed, targets: {}, ...request.history === true ? { history } : {} } })}\n`)
      void pipeline(writeResult({ ...failed, outputs: {} }, []), socket)
    })
  })
  await new Promise<void>((resolve) => { server.listen(path, resolve) })
  try {
    const at = join(dir, 'logs', 'history.jsonl')
    assert.deepEqual(await finishRun(path, 'session-a', at), { ok: false, text: '', failure: 'the run was cancelled' })
    assert.deepEqual((await readFile(at, 'utf8')).split('\n').slice(0, -1).map(line => JSON.parse(line) as unknown), history)
    await finishRun(path, 'session-a')
    assert.deepEqual(received, [true, undefined])
  } finally {
    await new Promise((resolve) => { server.close(resolve) })
  }
})
