import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { DEFAULT_IMAGE } from 'fleet-image/layout'
import type { CallHandler } from '../box/helper.ts'
import { FleetExts } from '../ext/exts.ts'
import { modulesOf } from '../tools/ts.ts'
import type { Exts } from './apis.ts'
import { Registry } from './registry.ts'
import { TauRuns, type Boxes, type RunBox } from './runs.ts'
import { TauService, type Sessions } from './service.ts'

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
  // The client of the extension that implements notes, which make()'s extensions provide.
  await mkdir(join(work, 'client'))
  await writeFile(join(work, 'client', 'index.js'), 'import { call } from "fleet-image/ext/client";\nexport function add(text) { return call("notes", "add", [text]); }\n')
  await writeFile(join(work, 'client', 'index.d.ts'), 'export declare function add(text: string): Promise<unknown>;\n')
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

  create(name: string): Promise<RunBox> {
    this.calls.push(`create ${name}`)
    this.existing.add(name)
    return Promise.resolve(this.box(name))
  }

  open(name: string): Promise<RunBox> {
    if (!this.existing.has(name)) return Promise.reject(new Error(`No such container: ${name}`))
    this.calls.push(`open ${name}`)
    return Promise.resolve(this.box(name))
  }

  exists(name: string): Promise<boolean> {
    return Promise.resolve(this.existing.has(name))
  }

  /** What answers the calls of the box's clients, as its last start was given it. */
  onCall: Parameters<RunBox['start']>[0]

  private box(name: string): RunBox {
    const record = (verb: string, call: string): void => {
      this.calls.push(call)
      if (verb === this.failing) throw new Error(`${verb} failed`)
    }
    return {
      container: name,
      start: async (onCall) => {
        record('start', 'start')
        this.onCall = onCall
      },
      stop: async () => { record('stop', 'stop') },
      remove: async () => {
        record('remove', 'remove')
        this.existing.delete(name)
      },
      copyIn: async (from, to) => { record('copyIn', `copyIn ${from} ${to}`) },
      request: (async (method: string, params: unknown) => {
        record(method, `${method} ${JSON.stringify(params)}`)
        return { code: 0, signal: null, stdout: '', stderr: '' }
      }) as RunBox['request'],
    }
  }
}

/** What the extension of notes, as make() provides it, was called with. */
const added: { args: unknown[]; sessionId: string }[] = []

/**
 * The tau service on runs in `work`, with the runs at hand, and, unless
 * `exts` says otherwise, an extension of notes whose client is the
 * fixture's, and whose `add` records its call.
 */
function make(work: string, log: (message: string) => void, sessions: Sessions, boxes?: Boxes, exts?: Exts): TauService & { tauRuns: TauRuns } {
  let provided = exts
  if (provided === undefined) {
    const own = new FleetExts()
    own.provide({
      api: 'notes',
      client: join(work, 'client'),
      methods: {
        add: (args, { sessionId }) => {
          added.push({ args, sessionId })
          return `added ${String(args[0])}`
        },
      },
    })
    provided = own
  }
  const runs = new TauRuns(new Registry(join(work, 'taus')), provided, log, boxes)
  return Object.assign(new TauService(runs, sessions, log), { tauRuns: runs })
}

/** dsh's sessions, as a record of what is done with them, with the call `failing` names failing once. */
class FakeSessions implements Sessions {
  readonly calls: string[] = []
  failing: string | undefined

  create(sessionId: string, project: string, title: string): Promise<void> {
    return this.record('create', `create ${sessionId} ${project} ${title}`)
  }

  prompt(sessionId: string, requestId: string, text: string): Promise<void> {
    return this.record('prompt', `prompt ${sessionId} ${requestId} ${text}`)
  }

  cancel(sessionId: string): void {
    this.calls.push(`cancel ${sessionId}`)
  }

  archive(sessionId: string): Promise<void> {
    return this.record('archive', `archive ${sessionId}`)
  }

  private async record(verb: string, call: string): Promise<void> {
    this.calls.push(call)
    if (verb !== this.failing) return
    this.failing = undefined
    throw new Error(`${verb} failed`)
  }
}

test('create sets up a stopped box with the handles and the tau, and registers the session', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes()
  const logged: string[] = []
  const service = make(work, (message) => { logged.push(message) }, new FakeSessions(), boxes)

  const created = await service.create(tauDir, values, work)
  const project = await realpath(work)
  assert.match(created.sessionId, /^session-[0-9a-f-]{36}$/u)
  assert.equal(created.box, `fleet-tau-${created.sessionId.slice('session-'.length)}`)
  assert.equal(created.prompt, EXPANDED)
  assert.deepEqual(boxes.calls, [
    `create ${created.box}`,
    'start',
    `exec ${JSON.stringify({ argv: ['mkdir', '-p', '/tau/self', '/tau/in', '/tau/workspace', '/tau/out', '/tau/out/pages', project, '/tau/node_modules/.fleet'] })}`,
    `copyIn ${tauDir} /tau/self`,
    `copyIn ${join(work, 'notes.md')} /tau/in/notes.md`,
    `copyIn ${join(work, 'site')} /tau/workspace/site`,
    `copyIn ${join(work, 'client')} /tau/node_modules/.fleet/notes`,
    `apis.link ${JSON.stringify({
      modules: '/tau/node_modules',
      apis: [{ name: 'notes', client: '/tau/node_modules/.fleet/notes', types: '/tau/self/api/notes' }],
      packages: [],
    })}`,
    'stop',
  ])

  const entry = await new Registry(join(work, 'taus')).get(created.sessionId)
  assert.equal(entry.box, created.box)
  assert.equal(entry.tauDir, tauDir)
  assert.equal(entry.project, project)
  assert.equal(entry.prompt, EXPANDED)
  assert.match(entry.promptRequestId, /^[0-9a-f-]{36}$/u)
  assert.equal(entry.promptedAt, undefined)
  assert.deepEqual(entry.apis, ['notes'])
  assert.deepEqual(entry.exposed, [{ specifier: '@api/notes' }])
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
  const service = make(work, () => {}, new FakeSessions(), boxes)
  await assert.rejects(service.create(tauDir, { ...values, style: undefined }, work), /style/u)
  await assert.rejects(service.create(tauDir, { ...values, notes: { $in: 'missing.md' } }, work), /handles do not fit/u)
  assert.deepEqual(boxes.calls, [])
})

test('create refuses a tau with an API no extension implements, or whose client does not fit, before it makes a box', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes()
  const none = make(work, () => {}, new FakeSessions(), boxes, new FleetExts())
  await assert.rejects(none.create(tauDir, values, work), /cannot run here:\n {2}@api\/notes: no extension implements it/u)
  await mkdir(join(work, 'other'))
  await writeFile(join(work, 'other', 'index.js'), 'export function add() {}\n')
  await writeFile(join(work, 'other', 'index.d.ts'), 'export declare function add(text: number): void;\n')
  const misfit = new FleetExts()
  misfit.provide({ api: 'notes', client: join(work, 'other'), methods: {} })
  await assert.rejects(make(work, () => {}, new FakeSessions(), boxes, misfit).create(tauDir, values, work), /does not implement @api\/notes/u)
  assert.deepEqual(boxes.calls, [])
})

test('the calls of a session\'s clients go to the extension\'s server, as that session\'s, for the APIs its tau declares', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes()
  const service = make(work, () => {}, new FakeSessions(), boxes)
  const { sessionId } = await service.create(tauDir, values, work)
  assert.equal(boxes.onCall, undefined)
  await service.start(sessionId)
  const signal = new AbortController().signal
  // Set by the start, which TypeScript does not see.
  const onCall = boxes.onCall as CallHandler | undefined
  assert.ok(onCall !== undefined)
  added.length = 0
  assert.equal(await onCall({ api: 'notes', method: 'add', args: ['milk'] }, signal), 'added milk')
  assert.deepEqual(added, [{ args: ['milk'], sessionId }])
  await assert.rejects(onCall({ api: 'notes', method: 'toString', args: [] }, signal), /the extension of notes has no method toString/u)
  await assert.rejects(onCall({ api: 'archives', method: 'add', args: [] }, signal), /declares no API archives/u)
})

test('a create that fails removes its box and registers nothing', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes()
  boxes.failing = 'copyIn'
  const service = make(work, () => {}, new FakeSessions(), boxes)
  await assert.rejects(service.create(tauDir, values, work), /copyIn failed/u)
  assert.equal(boxes.calls.at(-1), 'remove')
  assert.equal(boxes.existing.size, 0)
  await assert.rejects(readdir(join(work, 'taus')), /ENOENT/u)
})

test('a session\'s box starts, stops and is deleted, by this service or one started later', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes()
  const service = make(work, () => {}, new FakeSessions(), boxes)
  const { sessionId, box } = await service.create(tauDir, values, work)
  boxes.calls.length = 0

  await service.start(sessionId)
  await service.stop(sessionId)
  assert.deepEqual(boxes.calls, ['start', 'stop'])

  // As after a restart: the box is found through the registry.
  const later = make(work, () => {}, new FakeSessions(), boxes)
  boxes.calls.length = 0
  await later.start(sessionId)
  await later.tauRuns.close()
  assert.deepEqual(boxes.calls, [`open ${box}`, 'start', 'stop'])

  boxes.calls.length = 0
  await later.delete(sessionId)
  assert.deepEqual(boxes.calls, ['remove'])
  await assert.rejects(later.start(sessionId), new RegExp(`no tau session ${sessionId}`, 'u'))
  await assert.rejects(service.delete(sessionId), /no tau session/u)
})

test('the first start makes the dsh session in the caller\'s folder and gives it its prompt, once', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const sessions = new FakeSessions()
  const service = make(work, () => {}, sessions, new FakeBoxes())
  const { sessionId } = await service.create(tauDir, values, work)
  const { promptRequestId, project } = await new Registry(join(work, 'taus')).get(sessionId)
  assert.deepEqual(sessions.calls, [])

  await Promise.all([service.start(sessionId), service.start(sessionId)])
  await service.stop(sessionId)
  await service.start(sessionId)
  assert.deepEqual(sessions.calls, [
    `create ${sessionId} ${project} tau`,
    `prompt ${sessionId} ${promptRequestId} ${EXPANDED}`,
    `cancel ${sessionId}`,
  ])
  assert.notEqual((await new Registry(join(work, 'taus')).get(sessionId)).promptedAt, undefined)

  // As after a restart: the registry says the session has its prompt.
  sessions.calls.length = 0
  const later = make(work, () => {}, sessions, new FakeBoxes())
  await later.delete(sessionId)
  assert.deepEqual(sessions.calls, [`archive ${sessionId}`])
})

test('a start that failed on the way makes and prompts the session again, under the same request', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const sessions = new FakeSessions()
  const service = make(work, () => {}, sessions, new FakeBoxes())
  const { sessionId } = await service.create(tauDir, values, work)
  const { promptRequestId } = await new Registry(join(work, 'taus')).get(sessionId)

  sessions.failing = 'prompt'
  await assert.rejects(service.start(sessionId), /prompt failed/u)
  assert.equal((await new Registry(join(work, 'taus')).get(sessionId)).promptedAt, undefined)
  // Not prompted, so there is no turn to cancel.
  await service.stop(sessionId)
  await service.start(sessionId)
  assert.deepEqual(sessions.calls.map(call => call.split(' ').slice(0, 3).join(' ')), [
    `create ${sessionId} ${(await realpath(work))}`,
    `prompt ${sessionId} ${promptRequestId}`,
    `create ${sessionId} ${(await realpath(work))}`,
    `prompt ${sessionId} ${promptRequestId}`,
  ])
})

test('deleting archives the session before it removes the box, and a failed archive keeps both', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes()
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId, box } = await service.create(tauDir, values, work)

  sessions.failing = 'archive'
  await assert.rejects(service.delete(sessionId), /archive failed/u)
  assert.ok(boxes.existing.has(box))
  await new Registry(join(work, 'taus')).get(sessionId)

  await service.delete(sessionId)
  assert.ok(!boxes.existing.has(box))
  assert.deepEqual(sessions.calls, [`archive ${sessionId}`, `archive ${sessionId}`])
})

test('a tau session\'s box is started for its files and processes once, and again after a stop', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes()
  const service = make(work, () => {}, new FakeSessions(), boxes)
  const { sessionId, box } = await service.create(tauDir, values, work)
  boxes.calls.length = 0

  assert.equal(await service.tauRuns.boxFor('session-00000000-0000-4000-8000-000000000000'), undefined)
  assert.equal(await service.tauRuns.boxFor('not-a-tau-session'), undefined)
  const [first, second] = await Promise.all([service.tauRuns.boxFor(sessionId), service.tauRuns.boxFor(sessionId)])
  assert.equal(first?.container, box)
  assert.equal(first, second)
  await service.stop(sessionId)
  assert.equal((await service.tauRuns.boxFor(sessionId))?.container, box)
  assert.deepEqual(boxes.calls, ['start', 'stop', 'start'])
  await service.tauRuns.close()
  assert.deepEqual(boxes.calls, ['start', 'stop', 'start', 'stop'])

  // As after a restart: the registry says which sessions are a tau's.
  const later = make(work, () => {}, new FakeSessions(), boxes)
  assert.equal(later.tauRuns.isTau(sessionId), false)
  await later.tauRuns.load()
  assert.equal(later.tauRuns.isTau(sessionId), true)
  await later.delete(sessionId)
  assert.equal(later.tauRuns.isTau(sessionId), false)
  assert.equal(await later.tauRuns.boxFor(sessionId), undefined)
})

test('a host file is copied into a tau session\'s box once, before the box\'s next use, and again after a failure', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes()
  const logged: string[] = []
  const service = make(work, message => logged.push(message), new FakeSessions(), boxes)
  const { sessionId } = await service.create(tauDir, values, work)
  boxes.calls.length = 0
  const from = '/home/me/.dsh/attachments/v1/objects/09/0912'
  const to = '/fleet/attachments/v1/objects/09/0912'
  const copy = [
    'exec {"argv":["mkdir","-p","/fleet/attachments/v1/objects/09"]}',
    `copyIn ${from} ${to}`,
    `exec {"argv":["chmod","a=r","${to}"]}`,
  ]

  service.tauRuns.copyInOnce('not-a-tau-session', from, to)
  service.tauRuns.copyInOnce(sessionId, from, to)
  service.tauRuns.copyInOnce(sessionId, from, to)
  await service.tauRuns.boxFor(sessionId)
  assert.deepEqual(boxes.calls, ['start', ...copy])
  service.tauRuns.copyInOnce(sessionId, from, to)
  await service.tauRuns.boxFor(sessionId)
  assert.deepEqual(boxes.calls, ['start', ...copy])

  boxes.calls.length = 0
  boxes.failing = 'copyIn'
  const other = '/fleet/attachments/v1/objects/ab/ab34'
  service.tauRuns.copyInOnce(sessionId, from, other)
  await service.tauRuns.boxFor(sessionId)
  assert.match(logged.at(-1) ?? '', /^could not copy .* into the box of session-.*: copyIn failed$/)
  boxes.failing = undefined
  service.tauRuns.copyInOnce(sessionId, from, other)
  await service.tauRuns.boxFor(sessionId)
  assert.deepEqual(boxes.calls.filter(call => call.startsWith('copyIn')), [`copyIn ${from} ${other}`, `copyIn ${from} ${other}`])
})

test('deleting a session whose box is gone forgets the session', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes()
  const { sessionId, box } = await make(work, () => {}, new FakeSessions(), boxes).create(tauDir, values, work)
  boxes.existing.delete(box)
  const service = make(work, () => {}, new FakeSessions(), boxes)
  await assert.rejects(service.start(sessionId), /No such container/u)
  await service.delete(sessionId)
  await assert.rejects(service.start(sessionId), /no tau session/u)
})

test('only ids of the form the service mints name sessions', async (t) => {
  const { work } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions(), new FakeBoxes())
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
  const service = make(work, () => {}, new FakeSessions())
  const { sessionId, box, prompt } = await service.create(tauDir, values, work)
  try {
    assert.equal(prompt, EXPANDED)
    await service.start(sessionId)
    const { stdout } = await run('docker', ['exec', box, 'find', '/tau', '-path', '/tau/node_modules', '-prune', '-o', '-not', '-type', 'd', '-print'])
    assert.deepEqual(stdout.trim().split('\n').sort(), [
      '/tau/in/notes.md', '/tau/self/PROMPT.md', '/tau/self/api/notes/index.d.ts', '/tau/self/tau.json', '/tau/workspace/site/index.md',
    ])
    // A program below /tau imports the API, and its client's call reaches the extension's server, as this session's.
    added.length = 0
    const started = await service.tauRuns.boxFor(sessionId)
    const program = 'import { add } from "@api/notes"; process.stdout.write(await add("milk"));'
    const ran = await started?.request('exec', { argv: ['sh', '-c', `cd /tau/workspace && node --input-type=module --eval '${program}'`] })
    assert.deepEqual(ran, { code: 0, signal: null, stdout: 'added milk', stderr: '' })
    assert.deepEqual(added, [{ args: ['milk'], sessionId }])
    // A TypeScript program, checked against the tau's declarations, as ts_execute runs one.
    const entry = await new Registry(join(work, 'taus')).get(sessionId)
    const params = { root: '/tau', modules: modulesOf(entry), cwd: entry.project }
    const source = 'import { add } from "@api/notes"\nexport async function main(input: string): Promise<void> { await add(input) }'
    const outcome = await started?.request('ts.execute', { ...params, execution: 'e1', source, input: 'eggs' })
    assert.deepEqual({ ...outcome, durationMs: 0 }, { ok: true, value: null, stdout: '', stderr: '', durationMs: 0 })
    assert.deepEqual(added.at(-1), { args: ['eggs'], sessionId })
    const mistaken = await started?.request('ts.execute', { ...params, execution: 'e2', source: 'import { add } from "@api/notes"\nexport function main(): void { add(1) }' })
    assert.equal(mistaken?.ok === false && mistaken.error.name, 'TypeCheckError')
    assert.equal((await run('docker', ['exec', box, 'cat', '/tau/in/notes.md'])).stdout, 'buy milk\n')
    await run('docker', ['exec', box, 'test', '-d', '/tau/out/pages'])
    // Where dsh will run the session's work: the caller's folder, empty.
    assert.equal((await run('docker', ['exec', box, 'ls', '-A', await realpath(work)])).stdout, '')
    await service.stop(sessionId)
  } finally {
    await service.delete(sessionId)
  }
  await assert.rejects(run('docker', ['container', 'inspect', box]), /No such container/u)
})
