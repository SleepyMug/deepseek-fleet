import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { DEFAULT_IMAGE } from 'fleet-image/layout'
import { Registry } from './registry.ts'
import { TauService, type Boxes, type ServiceBox } from './service.ts'

const run = promisify(execFile)

const PROMPT = 'Add ${notes} to ${site} in a ${style} style, then write ${report} and fill ${pages}. You are ${self}.\n'
const EXPANDED = 'Add /tau/in/notes.md to /tau/workspace/site in a terse style, then write /tau/out/report.md and fill /tau/out/pages. You are /tau/self.\n'

/** A folder with a tau that takes a handle of each mode, and the caller's files for it. */
async function fixture(t: { after(fn: () => Promise<void>): void }): Promise<{ work: string; tauDir: string; values: Record<string, unknown> }> {
  const work = await mkdtemp(join(tmpdir(), 'fleet-tau-test-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const tauDir = join(work, 'tau')
  await mkdir(join(tauDir, 'api', 'notes'), { recursive: true })
  await writeFile(join(tauDir, 'PROMPT.md'), PROMPT)
  await writeFile(join(tauDir, 'api', 'notes', 'index.d.ts'), 'export declare function add(text: string): void;\n')
  await writeFile(join(tauDir, 'tau.json'), JSON.stringify({
    params: {
      style: { type: 'text', description: 'How to write.' },
      notes: { type: 'file', mode: 'in', description: 'What to add.' },
      site: { type: 'dir', mode: 'inout', description: 'The pages.' },
      report: { type: 'file', mode: 'out', description: 'What changed.' },
      pages: { type: 'dir', mode: 'out', description: 'New pages.' },
    },
  }))
  await writeFile(join(work, 'notes.md'), 'buy milk\n')
  await mkdir(join(work, 'site'))
  await writeFile(join(work, 'site', 'index.md'), '# Home\n')
  await mkdir(join(work, 'out'))
  const values = { style: 'terse', notes: { $in: 'notes.md' }, site: { $inout: 'site' }, report: { $out: 'out/report.md' }, pages: { $out: 'out/pages' } }
  return { work, tauDir, values }
}

/** Boxes that record what is done with them, and fail the verb `failing` names. */
class FakeBoxes implements Boxes {
  readonly calls: string[] = []
  readonly existing = new Set<string>()
  failing: string | undefined

  create(name: string): Promise<ServiceBox> {
    this.calls.push(`create ${name}`)
    this.existing.add(name)
    return Promise.resolve(this.box(name))
  }

  open(name: string): Promise<ServiceBox> {
    if (!this.existing.has(name)) return Promise.reject(new Error(`No such container: ${name}`))
    this.calls.push(`open ${name}`)
    return Promise.resolve(this.box(name))
  }

  exists(name: string): Promise<boolean> {
    return Promise.resolve(this.existing.has(name))
  }

  private box(name: string): ServiceBox {
    const record = (verb: string, call: string): void => {
      this.calls.push(call)
      if (verb === this.failing) throw new Error(`${verb} failed`)
    }
    return {
      container: name,
      start: async () => { record('start', 'start') },
      stop: async () => { record('stop', 'stop') },
      remove: async () => {
        record('remove', 'remove')
        this.existing.delete(name)
      },
      copyIn: async (from, to) => { record('copyIn', `copyIn ${from} ${to}`) },
      request: (async (method: string, params: unknown) => {
        record(method, `${method} ${JSON.stringify(params)}`)
        return { code: 0, signal: null, stdout: '', stderr: '' }
      }) as ServiceBox['request'],
    }
  }
}

test('create sets up a stopped box with the handles and the tau, and registers the session', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes()
  const logged: string[] = []
  const service = new TauService(new Registry(join(work, 'taus')), (message) => { logged.push(message) }, boxes)

  const created = await service.create(tauDir, values, work)
  assert.match(created.sessionId, /^session-[0-9a-f-]{36}$/u)
  assert.equal(created.box, `fleet-tau-${created.sessionId.slice('session-'.length)}`)
  assert.equal(created.prompt, EXPANDED)
  assert.deepEqual(boxes.calls, [
    `create ${created.box}`,
    'start',
    `exec ${JSON.stringify({ argv: ['mkdir', '-p', '/tau/self', '/tau/in', '/tau/workspace', '/tau/out', '/tau/out/pages'] })}`,
    `copyIn ${tauDir} /tau/self`,
    `copyIn ${join(work, 'notes.md')} /tau/in/notes.md`,
    `copyIn ${join(work, 'site')} /tau/workspace/site`,
    'stop',
  ])

  const entry = await new Registry(join(work, 'taus')).get(created.sessionId)
  assert.equal(entry.box, created.box)
  assert.equal(entry.tauDir, tauDir)
  assert.equal(entry.prompt, EXPANDED)
  assert.deepEqual(entry.apis, ['notes'])
  assert.deepEqual(entry.handles.map(handle => [handle.at, handle.mode, handle.kind, handle.host, handle.view]), [
    ['notes', 'in', 'file', join(work, 'notes.md'), '/tau/in/notes.md'],
    ['site', 'inout', 'dir', join(work, 'site'), '/tau/workspace/site'],
    ['report', 'out', 'file', join(work, 'out', 'report.md'), '/tau/out/report.md'],
    ['pages', 'out', 'dir', join(work, 'out', 'pages'), '/tau/out/pages'],
  ])
  assert.match(logged.join('\n'), new RegExp(`created ${created.sessionId} in box ${created.box}`, 'u'))
})

test('create refuses values that do not fit the tau before it makes a box', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes()
  const service = new TauService(new Registry(join(work, 'taus')), () => {}, boxes)
  await assert.rejects(service.create(tauDir, { ...values, style: undefined }, work), /style/u)
  await assert.rejects(service.create(tauDir, { ...values, notes: { $in: 'missing.md' } }, work), /handles do not fit/u)
  assert.deepEqual(boxes.calls, [])
})

test('a create that fails removes its box and registers nothing', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes()
  boxes.failing = 'copyIn'
  const service = new TauService(new Registry(join(work, 'taus')), () => {}, boxes)
  await assert.rejects(service.create(tauDir, values, work), /copyIn failed/u)
  assert.equal(boxes.calls.at(-1), 'remove')
  assert.equal(boxes.existing.size, 0)
  await assert.rejects(readdir(join(work, 'taus')), /ENOENT/u)
})

test('a session\'s box starts, stops and is deleted, by this service or one started later', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes()
  const service = new TauService(new Registry(join(work, 'taus')), () => {}, boxes)
  const { sessionId, box } = await service.create(tauDir, values, work)
  boxes.calls.length = 0

  await service.start(sessionId)
  await service.stop(sessionId)
  assert.deepEqual(boxes.calls, ['start', 'stop'])

  // As after a restart: the box is found through the registry.
  const later = new TauService(new Registry(join(work, 'taus')), () => {}, boxes)
  boxes.calls.length = 0
  await later.start(sessionId)
  await later.close()
  assert.deepEqual(boxes.calls, [`open ${box}`, 'start', 'stop'])

  boxes.calls.length = 0
  await later.delete(sessionId)
  assert.deepEqual(boxes.calls, ['remove'])
  await assert.rejects(later.start(sessionId), new RegExp(`no tau session ${sessionId}`, 'u'))
  await assert.rejects(service.delete(sessionId), /no tau session/u)
})

test('deleting a session whose box is gone forgets the session', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes()
  const { sessionId, box } = await new TauService(new Registry(join(work, 'taus')), () => {}, boxes).create(tauDir, values, work)
  boxes.existing.delete(box)
  const service = new TauService(new Registry(join(work, 'taus')), () => {}, boxes)
  await assert.rejects(service.start(sessionId), /No such container/u)
  await service.delete(sessionId)
  await assert.rejects(service.start(sessionId), /no tau session/u)
})

test('only ids of the form the service mints name sessions', async (t) => {
  const { work } = await fixture(t)
  const service = new TauService(new Registry(join(work, 'taus')), () => {}, new FakeBoxes())
  for (const id of ['../../etc/passwd', 'session-1', '']) {
    await assert.rejects(service.start(id), new RegExp(`no tau session ${id.replaceAll('.', '\\.')}`, 'u'))
  }
})

/** Why the test needs an image that is not there, or false. */
async function absent(image: string): Promise<string | false> {
  return run('docker', ['image', 'inspect', image]).then(() => false, () => `no Docker image ${image}; build it with \`pnpm image\``)
}

test('a real box gets the tau and the handles at their places', { skip: await absent(DEFAULT_IMAGE) }, async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const service = new TauService(new Registry(join(work, 'taus')), () => {})
  const { sessionId, box, prompt } = await service.create(tauDir, values, work)
  try {
    assert.equal(prompt, EXPANDED)
    await service.start(sessionId)
    const { stdout } = await run('docker', ['exec', box, 'find', '/tau', '-not', '-type', 'd'])
    assert.deepEqual(stdout.trim().split('\n').sort(), [
      '/tau/in/notes.md', '/tau/self/PROMPT.md', '/tau/self/api/notes/index.d.ts', '/tau/self/tau.json', '/tau/workspace/site/index.md',
    ])
    assert.equal((await run('docker', ['exec', box, 'cat', '/tau/in/notes.md'])).stdout, 'buy milk\n')
    await run('docker', ['exec', box, 'test', '-d', '/tau/out/pages'])
    await service.stop(sessionId)
  } finally {
    await service.delete(sessionId)
  }
  await assert.rejects(run('docker', ['container', 'inspect', box]), /No such container/u)
})
