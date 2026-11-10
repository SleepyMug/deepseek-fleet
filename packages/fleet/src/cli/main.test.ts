import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULT_IMAGE } from '@sleepymug/fleet-protocol/layout'

const MAIN = fileURLToPath(new URL('./main.js', import.meta.url))

/** The image the tests' boxes run: $FLEET_TEST_IMAGE, or the default. */
const IMAGE = process.env.FLEET_TEST_IMAGE ?? DEFAULT_IMAGE

interface Run {
  code: number
  stdout: string
  stderr: string
}

/** Run `fleet` with `input` piped to it, on the host whose home is `home`. */
function fleet(home: string, args: string[], input = ''): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [MAIN, ...args], { env: { ...process.env, FLEET_HOME: home, FLEET_SOCKET: '' } }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr })
    })
    child.stdin?.end(input)
  })
}

/** `fleet serve` in `home`, once it listens. */
async function serving(home: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [MAIN, 'serve', '--image', IMAGE], { env: { ...process.env, FLEET_HOME: home, FLEET_SOCKET: '' }, stdio: 'ignore' })
  while (!existsSync(join(home, 'fleet.sock'))) await delay(50)
  return child
}

const missing = await new Promise<boolean>((resolve) => {
  execFile('docker', ['image', 'inspect', IMAGE], (error) => { resolve(error !== null) })
})

test('fleet makes, lists, repls in and removes a box, on the host it serves', { skip: missing && `no Docker image ${IMAGE}; build it with \`pnpm image\`` }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'fleet-cli-'))
  const host = await serving(home)
  t.after(async () => {
    host.kill('SIGTERM')
    await new Promise((resolve) => { host.once('exit', resolve) })
    await rm(home, { recursive: true, force: true })
  })
  const created = await fleet(home, ['box', 'create', '--label', 'test=cli'])
  assert.equal(created.code, 0, created.stderr)
  const id = created.stdout.trim()
  assert.match(id, /^box-[0-9a-f]{16}$/u)
  try {
    assert.match((await fleet(home, ['box', 'list'])).stdout, new RegExp(`^${id} +stopped +test=cli$`, 'mu'))
    const repl = await fleet(home, ['box', 'repl', id], 'echo {"text":"hi"}\nnope\n')
    assert.equal(repl.code, 0, repl.stderr)
    assert.equal(repl.stdout, '{"text":"hi"}\n')
    assert.match(repl.stderr, /^error: fleet: no method nope$/mu)
    assert.match((await fleet(home, ['box', 'list'])).stdout, new RegExp(`^${id} +started`, 'mu'))
    assert.equal((await fleet(home, ['service', 'list'])).stdout, 'SERVICE  COMMANDS  WHAT IT IS\n')
  } finally {
    assert.equal((await fleet(home, ['box', 'rm', id])).code, 0)
  }
  assert.doesNotMatch((await fleet(home, ['box', 'list'])).stdout, new RegExp(`^${id} `, 'mu'))
  assert.match((await fleet(home, ['box', 'rm', id])).stderr, /no box/u)
})

test('fleet without a host says so', async () => {
  const home = await mkdtemp(join(tmpdir(), 'fleet-cli-none-'))
  try {
    const run = await fleet(home, ['box', 'list'])
    assert.equal(run.code, 1)
    assert.match(run.stderr, /no fleet host at \S+fleet\.sock: is `fleet serve` running\?/u)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('fleet points a mistaken command line to its usage', async () => {
  const home = tmpdir()
  for (const args of [[], ['nope'], ['box'], ['box', 'repl'], ['box', 'create', '--nope'], ['box', 'list', 'extra'], ['service'], ['image', 'build', 'a', 'b']]) {
    const run = await fleet(home, args)
    assert.equal(run.code, 2, args.join(' '))
    assert.match(run.stderr, /Run `fleet --help`/u)
  }
  assert.match((await fleet(home, ['--help'])).stdout, /^Usage: fleet <command>/u)
})
