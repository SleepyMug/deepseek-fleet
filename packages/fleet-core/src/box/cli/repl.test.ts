import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { text } from 'node:stream/consumers'
import { test } from 'node:test'
import { HelperError } from '../helper.ts'
import { parseLine, repl } from './repl.ts'

test('a line is blank, a command, or a method with a JSON object of params', () => {
  assert.deepEqual(parseLine('   '), { kind: 'empty' })
  assert.deepEqual(parseLine(' .help '), { kind: 'command', command: '.help' })
  assert.deepEqual(parseLine('hello'), { kind: 'request', method: 'hello', params: {} })
  assert.deepEqual(parseLine('echo  { "text": "a b" } '), { kind: 'request', method: 'echo', params: { text: 'a b' } })
  assert.throws(() => parseLine('echo {text}'), /are not JSON/u)
  assert.throws(() => parseLine('echo ["hi"]'), /are not a JSON object/u)
  assert.throws(() => parseLine('echo null'), /are not a JSON object/u)
})

/** A box that answers echo and hello, and refuses the rest as the helper connection does. */
const fakeBox = {
  request: (method: string, params: unknown): Promise<never> => {
    if (method === 'hello') return Promise.resolve({ protocol: 1 } as never)
    if (method !== 'echo') return Promise.reject(new Error(`fleet: no method ${method}`))
    const { text } = params as { text?: unknown }
    return typeof text === 'string' ? Promise.resolve({ text } as never) : Promise.reject(new HelperError('echo takes a text'))
  },
}

/** Run the REPL on piped input, as `fleet-box start` does without a terminal. */
async function session(input: string, box: object = fakeBox, signal?: AbortSignal): Promise<{ output: string; errors: string }> {
  const streams = { input: new PassThrough(), output: new PassThrough(), errors: new PassThrough() }
  const output = text(streams.output)
  const errors = text(streams.errors)
  streams.input.end(input)
  await repl(box as typeof fakeBox, { ...streams, terminal: false, signal })
  streams.output.end()
  streams.errors.end()
  return { output: await output, errors: await errors }
}

test('the REPL sends each line, printing results and errors apart, until .exit', async () => {
  const { output, errors } = await session([
    'hello', 'echo {"text":"hi"}', 'echo {}', 'nope', 'echo {', '', '.nope', '.exit', 'echo {"text":"after"}',
  ].join('\n'))
  assert.equal(output, '{"protocol":1}\n{"text":"hi"}\n')
  assert.equal(errors, [
    'error: echo takes a text', 'error: fleet: no method nope', 'error: the params of echo are not JSON: {', 'error: no command .nope; .help lists them', '',
  ].join('\n'))
})

test('the REPL lists the methods and commands', async () => {
  const { output } = await session('.help\n')
  assert.match(output, /^methods: hello, echo$/mu)
  assert.match(output, /^\.exit /mu)
})

test('an interrupt leaves the REPL without waiting for the request in progress', async () => {
  const interrupt = new AbortController()
  const stuck = { request: () => { interrupt.abort(); return new Promise(() => {}) } }
  const { output } = await session('echo {"text":"hi"}\necho {"text":"more"}\n', stuck, interrupt.signal)
  assert.equal(output, '')
})

test('on a terminal, Ctrl+D behind a request leaves once the request is answered', async () => {
  const streams = { input: new PassThrough(), output: new PassThrough(), errors: new PassThrough() }
  const output = text(streams.output)
  streams.input.write('echo {"text":"hi"}\r\u0004')
  await repl(fakeBox, { ...streams, terminal: true, prompt: '> ' })
  streams.output.end()
  assert.match(await output, /^\{"text":"hi"\}$/mu)
})

test('on a terminal, Ctrl+D on an empty line types .exit and leaves', async () => {
  const streams = { input: new PassThrough(), output: new PassThrough(), errors: new PassThrough() }
  const output = text(streams.output)
  streams.input.write('\u0004')
  await repl(fakeBox, { ...streams, terminal: true, prompt: '> ' })
  streams.output.end()
  // Without readline's cursor movements, the terminal shows the prompt with `.exit` typed after it.
  assert.match((await output).replace(/\x1b\[[0-9;]*[A-Za-z]/gu, ''), /^> \.exit\r?\n$/u)
})
