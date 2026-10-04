import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION, type HelperMessage, type HostMessage } from './protocol.ts'

/** Send requests to a helper on this machine and collect its answers until it exits. */
async function exchange(requests: HostMessage[]): Promise<HelperMessage[]> {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./main.js', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] })
  const answers: HelperMessage[] = []
  createInterface({ input: child.stdout }).on('line', (line) => { answers.push(JSON.parse(line) as HelperMessage) })
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`)
  child.stdin.end()
  const [code] = await once(child, 'close') as [number | null]
  assert.equal(code, 0)
  return answers.sort((a, b) => a.id - b.id)
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
