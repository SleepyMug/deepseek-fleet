import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Writable } from 'node:stream'
import { HELPER_NODE, TAU_ENTRY } from '../layout.ts'
import { type Pipe, readSetup, readTauCommand, requestPack, requestSetup, type Setup, type TauCommand, tauArgv } from './protocol.ts'

const SETUP: Setup = {
  prompt: 'Read /tau/in/notes.md.\n',
  cwd: '/tau/workspace',
  places: { notes: '/tau/in/notes.md' },
  modules: '/tau/node_modules',
  self: '/tau/self',
  links: [{ contract: '@test/notes', client: '/tau/node_modules/.fleet/@test/notes', declarations: '/tau/node_modules/.contracts/@test/notes' }],
  packages: [],
}

test('a command\'s line runs the runtime on the helper\'s Node, and the runtime reads it back', () => {
  const commands: TauCommand[] = [
    { command: 'setup', offered: [{ contract: '@test/notes', version: '1.3.0' }] },
    { command: 'pack', outcome: { ok: false, text: 'Half', failure: 'the run was cancelled' } },
  ]
  for (const command of commands) {
    const argv = tauArgv(command)
    assert.deepEqual(argv.slice(0, 2), [HELPER_NODE, TAU_ENTRY])
    assert.deepEqual(readTauCommand(argv.slice(2)), command)
  }
  assert.throws(() => readTauCommand(['run', '{}']), /no command run; setup or pack/u)
})

test('a setup sends the call, and takes the runtime\'s report once it has the shape of one', async () => {
  const sent: { argv: string[]; input: string }[] = []
  const pipe = (report: string): Pipe => async (argv, { input, output }) => {
    const chunks: Buffer[] = []
    for await (const chunk of input ?? []) chunks.push(Buffer.from(chunk))
    sent.push({ argv, input: Buffer.concat(chunks).toString('utf8') })
    output?.end(report)
  }
  const call = async function* (): AsyncGenerator<Uint8Array> { yield Buffer.from('the call') }
  const offered = [{ contract: '@test/notes', version: '1.3.0' }]
  assert.deepEqual(await requestSetup(pipe(`${JSON.stringify(SETUP)}\n`), call(), offered), SETUP)
  assert.deepEqual(sent, [{ argv: tauArgv({ command: 'setup', offered }), input: 'the call' }])
  await assert.rejects(requestSetup(pipe('oops'), call(), offered), /reported something else than JSON: oops/u)
  await assert.rejects(requestSetup(pipe(JSON.stringify({ ...SETUP, cwd: 'tau/workspace' })), call(), offered), /reported no setup/u)
})

test('a pack has the runtime write the result to where it is asked', async () => {
  const written: string[] = []
  const output = new Writable({ write(chunk: Buffer, _encoding, done) { written.push(chunk.toString('utf8')); done() } })
  const outcome = { ok: true, text: 'Done.' }
  await requestPack(async (argv, io) => {
    assert.deepEqual(argv, tauArgv({ command: 'pack', outcome }))
    io.output?.end('the result')
  }, outcome, output)
  assert.deepEqual(written, ['the result'])
})

test('a report that is not a setup is refused', () => {
  assert.deepEqual(readSetup(JSON.stringify({ ...SETUP, init: 'node /tau/self/init.mts' })).init, 'node /tau/self/init.mts')
  for (const broken of [{ ...SETUP, prompt: 1 }, { ...SETUP, init: 2 }, { ...SETUP, links: [{ contract: '@test/notes', client: '/x' }] }, { ...SETUP, places: undefined }, { ...SETUP, places: { notes: 'notes.md' } }, { ...SETUP, packages: [{ name: 'x', dir: 'x' }] }]) {
    assert.throws(() => readSetup(JSON.stringify(broken)), /reported no setup/u)
  }
})
