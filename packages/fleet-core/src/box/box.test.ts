import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { DEFAULT_IMAGE } from 'fleet-image/layout'
import { Box } from './box.ts'

const exec = promisify(execFile)

/** An image without fleet's runtime, in which no helper starts. */
const PLAIN_IMAGE = 'node:26.9.0-trixie-slim'

/** Why a test needs an image that is not there, or false. */
async function absent(image: string, hint: string): Promise<string | false> {
  return exec('docker', ['image', 'inspect', image]).then(() => false, () => `no Docker image ${image}; ${hint}`)
}

/** Whether the container runs; it rejects once the container is gone. */
async function running(container: string): Promise<boolean> {
  const { stdout } = await exec('docker', ['container', 'inspect', '--format', '{{.State.Running}}', container])
  return stdout.trim() === 'true'
}

test('a box keeps its container through stops and starts until removed', { skip: await absent(DEFAULT_IMAGE, 'build it with `pnpm image`') }, async () => {
  const box = await Box.create()
  try {
    assert.equal(await running(box.container), false)
    await assert.rejects(box.request('echo', { text: 'hi' }), /is not started/u)
    assert.equal((await Box.list()).find(info => info.name === box.container)?.state, 'created')

    await box.start()
    assert.deepEqual(await box.request('echo', { text: 'hi' }), { text: 'hi' })
    await exec('docker', ['exec', box.container, 'touch', '/kept'])

    await box.stop()
    assert.equal(await running(box.container), false)
    await assert.rejects(box.request('echo', { text: 'hi' }), /is not started/u)

    // Another handle on the same container, as another process would open it.
    const again = await Box.open(box.container)
    await again.start()
    assert.equal((await Box.list()).find(info => info.name === box.container)?.state, 'running')
    assert.deepEqual(await again.request('echo', { text: 'again' }), { text: 'again' })
    await exec('docker', ['exec', box.container, 'test', '-e', '/kept'])
    await again.stop()
  } finally {
    await box.remove()
  }
  await assert.rejects(running(box.container), /No such container/u)
  await assert.rejects(Box.open(box.container), /No such container/u)
})

test('a box copies whole folders in and out, running or not', { skip: await absent(DEFAULT_IMAGE, 'build it with `pnpm image`') }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'fleet-box-test-'))
  const box = await Box.create()
  try {
    const source = join(work, 'source')
    await mkdir(join(source, 'sub'), { recursive: true })
    await writeFile(join(source, 'sub', 'file'), 'hi\n')
    await symlink('sub/file', join(source, 'link'))

    // Into a stopped box, and out of a running one.
    await box.copyIn(source, '/data')
    await box.start()
    assert.equal((await exec('docker', ['exec', box.container, 'cat', '/data/link'])).stdout, 'hi\n')
    await exec('docker', ['exec', box.container, 'sh', '-c', 'echo made > /data/made'])
    await box.copyOut('/data', join(work, 'out'))
    assert.equal(await readFile(join(work, 'out', 'sub', 'file'), 'utf8'), 'hi\n')
    assert.equal(await readlink(join(work, 'out', 'link')), 'sub/file')
    assert.equal(await readFile(join(work, 'out', 'made'), 'utf8'), 'made\n')

    // Into a folder that is there already, which keeps what it had.
    await box.copyIn(source, '/data')
    await exec('docker', ['exec', box.container, 'test', '-e', '/data/made'])

    await assert.rejects(box.copyIn(source, 'data'), /not an absolute path/u)
    await assert.rejects(box.copyIn(join(source, 'sub', 'file'), '/data'), /is not a folder/u)
    await assert.rejects(box.copyIn(source, '/no/such/parent'), /docker cp failed/u)
  } finally {
    await box.remove()
    await rm(work, { recursive: true, force: true })
  }
})

test('a box whose helper does not start is left stopped', { skip: await absent(PLAIN_IMAGE, `pull it with \`docker pull ${PLAIN_IMAGE}\``) }, async () => {
  const box = await Box.create({ image: PLAIN_IMAGE })
  try {
    await assert.rejects(box.start(), /the helper exited/u)
    assert.equal(await running(box.container), false)
  } finally {
    await box.remove()
  }
})

test('only a container a box made opens as a box', { skip: await absent(PLAIN_IMAGE, `pull it with \`docker pull ${PLAIN_IMAGE}\``) }, async () => {
  const { stdout } = await exec('docker', ['create', PLAIN_IMAGE, 'true'])
  const container = stdout.trim()
  try {
    await assert.rejects(Box.open(container), /is not a box/u)
    assert.equal((await Box.list()).some(info => container.startsWith(info.name)), false)
  } finally {
    await exec('docker', ['rm', '--force', container])
  }
})

test('a box needs its image there already', async () => {
  await assert.rejects(Box.create({ image: 'fleet-no-such-image:none' }), /docker create failed/u)
})
