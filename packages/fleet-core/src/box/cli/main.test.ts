import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULT_IMAGE } from '@sleepymug/fleet-box-runtime/layout'

const MAIN = fileURLToPath(new URL('./main.js', import.meta.url))

interface Run {
  code: number
  stdout: string
  stderr: string
}

/** Run `fleet-box` with `input` piped to it. */
function fleetBox(args: string[], input = ''): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [MAIN, ...args], (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr })
    })
    child.stdin?.end(input)
  })
}

const missing = await new Promise<boolean>((resolve) => {
  execFile('docker', ['image', 'inspect', DEFAULT_IMAGE], (error) => { resolve(error !== null) })
})

test('fleet-box creates, lists, starts and deletes a box', { skip: missing && `no Docker image ${DEFAULT_IMAGE}; build it with \`pnpm image\`` }, async () => {
  const name = `fleet-box-test-${randomBytes(4).toString('hex')}`
  const created = await fleetBox(['create', '--name', name])
  try {
    assert.equal(created.stdout, `${name}\n`)
    assert.match((await fleetBox(['list'])).stdout, new RegExp(`^${name} +Created +${DEFAULT_IMAGE}$`, 'mu'))

    const started = await fleetBox(['start', name], 'echo {"text":"hi"}\nnope\n')
    assert.equal(started.code, 0)
    assert.equal(started.stdout, '{"text":"hi"}\n')
    assert.match(started.stderr, /^error: fleet: no method nope$/mu)
    assert.match(started.stderr, new RegExp(`^fleet-box: ${name} stopped$`, 'mu'))
    assert.match((await fleetBox(['list'])).stdout, new RegExp(`^${name} +Exited`, 'mu'))
  } finally {
    assert.equal((await fleetBox(['delete', name])).code, 0)
  }
  assert.doesNotMatch((await fleetBox(['list'])).stdout, new RegExp(`^${name} `, 'mu'))
  assert.match((await fleetBox(['delete', name])).stderr, /No such container/u)
})

test('fleet-box copies folders into a box and out of it', { skip: missing && `no Docker image ${DEFAULT_IMAGE}; build it with \`pnpm image\`` }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'fleet-box-test-'))
  const name = (await fleetBox(['create'])).stdout.trim()
  try {
    await mkdir(join(work, 'in', 'sub'), { recursive: true })
    await writeFile(join(work, 'in', 'sub', 'file'), 'hi\n')
    assert.deepEqual(await fleetBox(['copy-in', name, join(work, 'in'), '/data']), { code: 0, stdout: '', stderr: '' })
    assert.deepEqual(await fleetBox(['copy-out', name, '/data', join(work, 'out')]), { code: 0, stdout: '', stderr: '' })
    assert.equal(await readFile(join(work, 'out', 'sub', 'file'), 'utf8'), 'hi\n')

    const relative = await fleetBox(['copy-in', name, join(work, 'in'), 'data'])
    assert.equal(relative.code, 1)
    assert.match(relative.stderr, /^fleet-box: fleet: data is not an absolute path in the container$/mu)
  } finally {
    await fleetBox(['delete', name])
    await rm(work, { recursive: true, force: true })
  }
})

test('fleet-box points a mistaken command line to its usage', async () => {
  for (const args of [[], ['nope'], ['start'], ['create', '--nope'], ['list', 'extra'], ['copy-in', 'box', 'from'], ['copy-out', 'box', 'from', 'to', 'more']]) {
    const run = await fleetBox(args)
    assert.equal(run.code, 2, args.join(' '))
    assert.match(run.stderr, /Run `fleet-box --help`/u)
  }
  assert.match((await fleetBox(['--help'])).stdout, /^Usage: fleet-box <command>/u)
})
