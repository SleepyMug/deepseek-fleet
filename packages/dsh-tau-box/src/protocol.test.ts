import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HELPER_NODE } from '@sleepymug/fleet-protocol/layout'
import { BOX_ENTRY, type Pipe, readSetup, readTauCommand, requestPack, requestSetup, type Setup, type TauCommand, tauArgv } from './protocol.ts'

const SETUP: Setup = {
  prompt: 'Read /tau/in/notes.md.\n',
  cwd: '/tau/workspace',
  places: { notes: '/tau/in/notes.md' },
  self: '/tau/self',
  programs: '/tau',
  packages: [{ name: 'kit', dir: '/tau/node_modules/kit', description: 'A kit.' }],
}

test('a command\'s line runs the half on the helper\'s Node, from the tau service\'s package in the box, and the half reads it back', () => {
  assert.equal(BOX_ENTRY, '/opt/fleet/services/tau/lib/box/main.js')
  const commands: TauCommand[] = [{ command: 'setup' }, { command: 'pack', outcome: { ok: false, text: 'Half', failure: 'the run was cancelled' } }]
  for (const command of commands) {
    const argv = tauArgv(command)
    assert.deepEqual(argv.slice(0, 2), [HELPER_NODE, BOX_ENTRY])
    assert.deepEqual(readTauCommand(argv.slice(2)), command)
  }
  assert.throws(() => readTauCommand(['run', '{}']), /no command run; setup or pack/u)
})

test('a setup sends the call, and takes the half\'s report once it has the shape of one', async () => {
  const sent: { argv: string[]; input?: string }[] = []
  const pipe = (report: string): Pipe => async (argv, { input }) => {
    sent.push({ argv, ...input === undefined ? {} : { input } })
    return report
  }
  assert.deepEqual(await requestSetup(pipe(`${JSON.stringify(SETUP)}\n`), '/runs/call.tar'), SETUP)
  assert.deepEqual(sent, [{ argv: tauArgv({ command: 'setup' }), input: '/runs/call.tar' }])
  await assert.rejects(requestSetup(pipe('oops'), '/runs/call.tar'), /reported something else than JSON: oops/u)
  await assert.rejects(requestSetup(pipe(JSON.stringify({ ...SETUP, cwd: 'tau/workspace' })), '/runs/call.tar'), /reported no setup/u)
})

test('a pack has the half write the result to where it is asked', async () => {
  const outcome = { ok: true, text: 'Done.' }
  const asked: unknown[] = []
  await requestPack(async (argv, io) => {
    asked.push([argv, io])
    return ''
  }, outcome, '/runs/result.tar')
  assert.deepEqual(asked, [[tauArgv({ command: 'pack', outcome }), { output: '/runs/result.tar' }]])
})

test('a report that is not a setup is refused', () => {
  assert.deepEqual(readSetup(JSON.stringify({ ...SETUP, init: 'node /tau/self/init.mts' })).init, 'node /tau/self/init.mts')
  for (const broken of [{ ...SETUP, prompt: 1 }, { ...SETUP, init: 2 }, { ...SETUP, places: undefined }, { ...SETUP, places: { notes: 'notes.md' } }, { ...SETUP, packages: [{ name: 'x', dir: 'x' }] }, { ...SETUP, programs: undefined }]) {
    assert.throws(() => readSetup(JSON.stringify(broken)), /reported no setup/u)
  }
})
