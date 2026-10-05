import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { BoundHandle } from '@sleepymug/tau'
import { applyResult, packCall, writeCall, writeResult, type Result } from '@sleepymug/tau/call'
import { DEFAULT_IMAGE } from 'fleet-box-runtime/layout'
import { pack, setup } from 'fleet-box-runtime/tau/endpoint'
import type { CallHandler } from '../box/helper.ts'
import { FleetExts } from '../ext/exts.ts'
import { modulesOf } from '../tools/ts.ts'
import type { Exts } from './apis.ts'
import { Registry, type Caller } from './registry.ts'
import { HOST, TauRuns, type Boxes, type RunBox } from './runs.ts'
import type { Outcome } from './outcome.ts'
import { TauService, abortable, type Sessions } from './service.ts'

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
  await writeFile(join(work, 'client', 'index.js'), 'import { call } from "fleet-box-runtime/ext/client";\nexport function add(text) { return call("notes", "add", [text]); }\n')
  await writeFile(join(work, 'client', 'index.d.ts'), 'export declare function add(text: string): Promise<unknown>;\n')
  await writeFile(join(work, 'notes.md'), 'buy milk\n')
  await mkdir(join(work, 'site'))
  await writeFile(join(work, 'site', 'index.md'), '# Home\n')
  await mkdir(join(work, 'out'))
  const values = { style: 'terse', notes: { $in: 'notes.md' }, site: { $inout: 'site' }, report: { $out: 'out/report.md' }, pages: { $out: 'out/pages' } }
  return { work, tauDir, values }
}

/**
 * What the agent leaves in the box, by path: a file's text, or null for a
 * folder. By default, what the fixture's tau declares at the places of its
 * `$out` and `$inout` handles.
 */
type Left = Record<string, string | null>

const LEFT: Left = {
  '/tau/workspace/site': null,
  '/tau/workspace/site/index.md': '# Home\n\nbuy milk\n',
  '/tau/workspace/site/milk.md': '# Milk\n',
  '/tau/out/report.md': 'Added milk.\n',
  '/tau/out/pages': null,
  '/tau/out/pages/a.md': 'A\n',
}

/**
 * Boxes that record what is done with them, and fail the verb `failing`
 * names. Each has its files in a folder of `work`, where it places a call,
 * and packs a result from what `left` says the agent left, as its image
 * would (fleet-box-runtime/tau/endpoint), or as `tamper` says, in place of
 * that.
 */
class FakeBoxes implements Boxes {
  readonly calls: string[] = []
  readonly existing = new Set<string>()
  failing: string | undefined
  left: Left = { ...LEFT }
  tamper: ((outcome: Result, handles: BoundHandle[]) => AsyncIterable<Uint8Array>) | undefined

  constructor(private readonly work: string) {}

  /** Where a box has its files. */
  root(name: string): string {
    return join(this.work, 'boxes', name)
  }

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
      pipe: async (argv, io) => {
        const [, , command, json] = argv
        record('pipe', `pipe ${String(command)}`)
        const root = this.root(name)
        if (command === 'setup') {
          const report = await setup(io?.input ?? Readable.from([]), root)
          await pipeline(Readable.from([JSON.stringify(report)]), io?.output ?? process.stdout)
          return
        }
        const { outcome } = JSON.parse(json ?? '') as { outcome: Result }
        const { handles } = JSON.parse(await readFile(join(root, '/tau/.run.json'), 'utf8')) as { handles: BoundHandle[] }
        for (const [path, text] of Object.entries(this.left).sort(([a], [b]) => a.localeCompare(b))) {
          const at = join(root, path)
          if (text === null) await mkdir(at, { recursive: true })
          else await mkdir(dirname(at), { recursive: true }).then(() => writeFile(at, text))
        }
        await pipeline(Readable.from(this.tamper?.(outcome, handles) ?? await pack(outcome, root)), io?.output ?? process.stdout)
      },
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

/** A call of the tau at `tauDir` with `values`, packed in `cwd`, as `fleet` sends it, with what it says of itself. */
function callOf(tauDir: string, values: unknown, cwd: string): { about: { title: string; project: string; targets: Record<string, string> }; archive: AsyncIterable<Uint8Array> } {
  const packed = packCall(tauDir, values, { cwd })
  return { about: { title: basename(packed.tauDir), project: cwd, targets: packed.targets }, archive: packed.archive }
}

/** Start a run of the tau at `tauDir` with `values`, packed in `cwd`, as a caller does. */
function startIn(service: TauService, caller: Caller, tauDir: string, values: unknown, cwd: string): ReturnType<TauService['start']> {
  const { about, archive } = callOf(tauDir, values, cwd)
  return service.start(caller, about, archive)
}

/** Set up a run's box for the tau at `tauDir` with `values`, packed in `cwd`. */
function create(service: { tauRuns: TauRuns }, tauDir: string, values: unknown, cwd: string): ReturnType<TauRuns['create']> {
  const { about, archive } = callOf(tauDir, values, cwd)
  return service.tauRuns.create(archive, about)
}

/**
 * Finish a run as a caller does: wait for it, put what it gave back where
 * its targets say, and give back how it ended, which the result agrees with.
 */
async function finish(service: TauService, caller: Caller, sessionId: string): Promise<Result> {
  const { result, targets, archive } = await service.finish(caller, sessionId, new AbortController().signal)
  assert.deepEqual(await applyResult(archive, targets), result)
  return result
}

/** How a run's agent ended, as dsh's log has it, for a turn that completed with this text. */
function completed(text: string): Outcome {
  return { end: { kind: 'completed' }, text }
}

/**
 * dsh's sessions, as a record of what is done with them, with the call
 * `failing` names failing once. A session's agent is at work until the test
 * ends it, with {@link end}.
 */
class FakeSessions implements Sessions {
  readonly calls: string[] = []
  failing: string | undefined
  private readonly ends = new Map<string, PromiseWithResolvers<Outcome>>()

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

  settled(sessionId: string, signal: AbortSignal): Promise<Outcome> {
    return abortable(this.ending(sessionId).promise, signal)
  }

  /** End a session's agent's work, as it ended. */
  end(sessionId: string, outcome: Outcome): void {
    this.ending(sessionId).resolve(outcome)
  }

  private ending(sessionId: string): PromiseWithResolvers<Outcome> {
    let ending = this.ends.get(sessionId)
    if (ending === undefined) this.ends.set(sessionId, ending = Promise.withResolvers())
    return ending
  }

  private async record(verb: string, call: string): Promise<void> {
    this.calls.push(call)
    if (verb !== this.failing) return
    this.failing = undefined
    throw new Error(`${verb} failed`)
  }
}

test('setting up a run\'s box reads its call, has the box place the handles, copies in the tau, leaves the box stopped, and registers the session', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes(work)
  const logged: string[] = []
  const service = make(work, (message) => { logged.push(message) }, new FakeSessions(), boxes)

  const created = await create(service, tauDir, values, work)
  const project = await realpath(work)
  assert.match(created.sessionId, /^session-[0-9a-f-]{36}$/u)
  assert.equal(created.box, `fleet-tau-${created.sessionId.slice('session-'.length)}`)
  assert.equal(created.prompt, EXPANDED)
  assert.deepEqual(boxes.calls, [
    `create ${created.box}`,
    'start',
    'pipe setup',
    `copyIn ${join(work, 'client')} /tau/node_modules/.fleet/notes`,
    `apis.link ${JSON.stringify({
      modules: '/tau/node_modules',
      apis: [{ name: 'notes', client: '/tau/node_modules/.fleet/notes', types: '/tau/self/api/notes' }],
      packages: [],
    })}`,
    'stop',
  ])
  // The box's runtime placed everything where it has things.
  const root = boxes.root(created.box)
  assert.equal(await readFile(join(root, 'tau/in/notes.md'), 'utf8'), 'buy milk\n')
  assert.equal(await readFile(join(root, 'tau/workspace/site/index.md'), 'utf8'), '# Home\n')
  assert.equal(await readFile(join(root, 'tau/self/PROMPT.md'), 'utf8'), PROMPT)
  assert.deepEqual(await readdir(join(root, 'tau/out')), ['pages'])
  // The call is kept; the tau read from it here is gone.
  assert.deepEqual(await readdir(join(work, 'taus', created.sessionId)), ['call.tar'])

  const entry = await new Registry(join(work, 'taus')).get(created.sessionId)
  assert.equal(entry.box, created.box)
  assert.equal(entry.title, 'tau')
  assert.equal(entry.project, project)
  assert.equal(entry.prompt, EXPANDED)
  assert.match(entry.promptRequestId, /^[0-9a-f-]{36}$/u)
  assert.equal(entry.promptedAt, undefined)
  assert.deepEqual(entry.apis, ['notes'])
  assert.deepEqual(entry.exposed, [{ specifier: '@api/notes' }])
  assert.deepEqual(entry.handles.map(handle => [handle.at, handle.mode, handle.kind, handle.name, handle.blob, handle.host, handle.view]), [
    ['notes', 'in', 'file', 'notes.md', 'b0', undefined, '/tau/in/notes.md'],
    ['site', 'inout', 'dir', 'site', 'b1', undefined, '/tau/workspace/site'],
    ['report', 'out', 'file', 'report.md', undefined, undefined, '/tau/out/report.md'],
    ['pages', 'out', 'dir', 'pages', undefined, undefined, '/tau/out/pages'],
  ])
  assert.deepEqual(entry.targets, { '/site': join(work, 'site'), '/report': join(work, 'out', 'report.md'), '/pages': join(work, 'out', 'pages') })
  assert.equal(entry.cwd, '/tau/workspace')
  assert.equal(entry.modules, '/tau/node_modules')
  assert.match(logged.join('\n'), new RegExp(`created ${created.sessionId} in box ${created.box}`, 'u'))
})

/** The bytes of an archive. */
async function bytesOf(archive: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of archive) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes
}

test('start refuses a call that breaks the spec, carries no tau, or whose values do not fit the tau, before it makes a box', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, new FakeSessions(), boxes)
  const about = { title: 'tau', project: work, targets: {} }
  const whole = await bytesOf(callOf(tauDir, values, work).archive)
  await assert.rejects(service.start(HOST, about, once(whole.subarray(0, 1024))), /^Error: the call breaks the spec: /u)
  await assert.rejects(service.start(HOST, about, packCall(tauDir, values, { cwd: work }, { tau: false }).archive), /^Error: fleet: the call does not carry its tau$/u)
  const unfit = writeCall({ values: { style: 'terse' }, tau: { kind: 'dir', blob: 'tau' } }, [{ id: 'tau', path: tauDir }])
  await assert.rejects(service.start(HOST, about, unfit), /^Error: the values do not fit the tau:\n {2}no value for notes, site, report, pages$/u)
  // A tau's problems name it by the run's title.
  await mkdir(join(work, 'empty'))
  const empty = writeCall({ values: {}, tau: { kind: 'dir', blob: 'tau' } }, [{ id: 'tau', path: join(work, 'empty') }])
  await assert.rejects(service.start(HOST, { ...about, title: 'mine' }, empty), /^Error: the tau mine: not a tau \(no PROMPT\.md\)$/u)
  // A tau whose links lead out of it is no blob.
  await symlink('/etc/passwd', join(tauDir, 'leak.md'))
  await assert.rejects(service.start(HOST, about, writeCall({ values: {}, tau: { kind: 'dir', blob: 'tau' } }, [{ id: 'tau', path: tauDir }])),
    /the call breaks the spec: blobs\/tau\/leak\.md: leads to the absolute path \/etc\/passwd/u)
  await assert.rejects(service.start(HOST, { ...about, project: 'here' }, once(whole)), /names its project, an absolute path/u)
  assert.deepEqual(boxes.calls, [])
  assert.deepEqual(await readdir(join(work, 'taus')), [])
})

test('start refuses a tau with an API no extension implements, or whose client does not fit, before it makes a box', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes(work)
  const none = make(work, () => {}, new FakeSessions(), boxes, new FleetExts())
  await assert.rejects(startIn(none, HOST, tauDir, values, work), /the tau tau cannot run here:\n {2}@api\/notes: no extension implements it/u)
  await mkdir(join(work, 'other'))
  await writeFile(join(work, 'other', 'index.js'), 'export function add() {}\n')
  await writeFile(join(work, 'other', 'index.d.ts'), 'export declare function add(text: number): void;\n')
  const misfit = new FleetExts()
  misfit.provide({ api: 'notes', client: join(work, 'other'), methods: {} })
  await assert.rejects(startIn(make(work, () => {}, new FakeSessions(), boxes, misfit), HOST, tauDir, values, work), /does not implement @api\/notes/u)
  assert.deepEqual(boxes.calls, [])
})

test('the calls of a session\'s clients go to the extension\'s server, as that session\'s, for the APIs its tau declares', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, new FakeSessions(), boxes)
  const { sessionId } = await create(service, tauDir, values, work)
  assert.equal(boxes.onCall, undefined)
  await service.tauRuns.start(sessionId)
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

test('a set-up that fails removes its box and registers nothing', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes(work)
  boxes.failing = 'copyIn'
  const service = make(work, () => {}, new FakeSessions(), boxes)
  await assert.rejects(startIn(service, HOST, tauDir, values, work), /copyIn failed/u)
  assert.equal(boxes.calls.at(-1), 'remove')
  assert.equal(boxes.existing.size, 0)
  assert.deepEqual(await readdir(join(work, 'taus')), [])
})

test('a run starts its box, makes the dsh session in the caller\'s folder with the prompt, and ends once its agent is done', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId } = await startIn(service, HOST, tauDir, values, work)
  const { promptRequestId, project } = await new Registry(join(work, 'taus')).get(sessionId)
  assert.deepEqual(boxes.calls.slice(-2), ['stop', 'start'])
  assert.deepEqual(sessions.calls, [`create ${sessionId} ${project} tau`, `prompt ${sessionId} ${promptRequestId} ${EXPANDED}`])
  assert.notEqual((await new Registry(join(work, 'taus')).get(sessionId)).promptedAt, undefined)
  assert.deepEqual({ ...await service.status(HOST, sessionId), createdAt: '' }, { sessionId, title: 'tau', project, state: 'running', createdAt: '' })

  const finishing = finish(service, HOST, sessionId)
  sessions.end(sessionId, completed('Done.'))
  assert.deepEqual(await finishing, { ok: true, text: 'Done.' })
  assert.equal(boxes.calls.at(-1), 'stop')
  const status = await service.status(HOST, sessionId)
  assert.equal(status.state, 'finished')
  assert.deepEqual(status.result, { ok: true, text: 'Done.' })
  assert.notEqual(status.endedAt, undefined)
  // The same again, and from a service started later.
  assert.deepEqual(await finish(service, HOST, sessionId), { ok: true, text: 'Done.' })
  const later = make(work, () => {}, new FakeSessions(), boxes)
  // As fleet-tau-runs loads them, before the service.
  await later.tauRuns.load()
  await later.load()
  assert.deepEqual(await finish(later, HOST, sessionId), { ok: true, text: 'Done.' })
})

test('a run that succeeded gives back what its agent left, packed by its box, with where the caller has its handles', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  await writeFile(join(work, 'site', 'kept.md'), 'kept\n')
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId } = await startIn(service, HOST, tauDir, values, work)
  sessions.end(sessionId, completed('Done.'))
  // Ended, packed and checked, and kept for each finish.
  while ((await service.status(HOST, sessionId)).state === 'running') await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual((await service.status(HOST, sessionId)).result, { ok: true, text: 'Done.' })
  assert.deepEqual(boxes.calls.filter(call => call.startsWith('pipe')), ['pipe setup', 'pipe pack'])
  assert.deepEqual(await readdir(join(work, 'taus', sessionId)), ['call.tar', 'result.tar'])

  // The service puts nothing at the caller's paths; the caller does, where the targets say.
  const { result, targets, archive } = await service.finish(HOST, sessionId, new AbortController().signal)
  assert.deepEqual(result, { ok: true, text: 'Done.' })
  assert.deepEqual(targets, { '/site': join(work, 'site'), '/report': join(work, 'out', 'report.md'), '/pages': join(work, 'out', 'pages') })
  await assert.rejects(readFile(join(work, 'out', 'report.md')), /ENOENT/u)
  assert.deepEqual(await applyResult(archive, targets), result)
  assert.equal(await readFile(join(work, 'out', 'report.md'), 'utf8'), 'Added milk.\n')
  assert.deepEqual(await readdir(join(work, 'out', 'pages')), ['a.md'])
  assert.deepEqual((await readdir(join(work, 'site'))).sort(), ['index.md', 'kept.md', 'milk.md'])
  assert.equal(await readFile(join(work, 'site', 'index.md'), 'utf8'), '# Home\n\nbuy milk\n')
  assert.deepEqual(await finish(service, HOST, sessionId), result)
  assert.deepEqual(await readdir(join(work, 'taus', sessionId)), ['call.tar', 'result.tar'])
})

test('a run whose agent did not leave what its tau declares fails, and gives back nothing', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  delete boxes.left['/tau/out/report.md']
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId } = await startIn(service, HOST, tauDir, values, work)
  sessions.end(sessionId, completed('Done.'))
  const result = await finish(service, HOST, sessionId)
  assert.equal(result.ok, false)
  assert.equal(result.text, 'Done.')
  assert.match(result.failure ?? '', /^the run did not leave what the tau declares:\n {2}report: \S+\/tau\/out\/report\.md does not exist$/u)
  assert.deepEqual(await readdir(join(work, 'out')), [])
  assert.deepEqual(await readdir(join(work, 'site')), ['index.md'])
})

test('a result its box packs that does not fit the run fails the run, since the box is the agent\'s', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  const run = async (): Promise<Result> => {
    const { sessionId } = await startIn(service, HOST, tauDir, values, work)
    sessions.end(sessionId, completed('Done.'))
    return await finish(service, HOST, sessionId)
  }
  boxes.tamper = () => writeResult({ ok: true, text: 'Done.', outputs: {} }, [])
  assert.deepEqual(await run(), {
    ok: false,
    text: 'Done.',
    failure: 'could not get back what the run gave: the result does not fit the run:\n  site: the run succeeded, but gave nothing back for it\n  report: the run succeeded, but gave nothing back for it\n  pages: the run succeeded, but gave nothing back for it',
  })
  boxes.tamper = () => writeResult({ ok: true, text: 'Something else.', outputs: {} }, [])
  assert.equal((await run()).failure, 'could not get back what the run gave: its text is not the agent\'s')
  boxes.tamper = () => once(Buffer.from('not an archive'))
  assert.match((await run()).failure ?? '', /^could not get back what the run gave: the result breaks the spec: /u)
  assert.deepEqual(await readdir(join(work, 'out')), [])
})

test('what a run that failed left is not packed, nor given back', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId } = await startIn(service, HOST, tauDir, values, work)
  sessions.end(sessionId, { end: { kind: 'aborted', reason: { kind: 'user' } }, text: '' })
  assert.equal((await finish(service, HOST, sessionId)).ok, false)
  assert.deepEqual(boxes.calls.filter(call => call === 'pipe pack'), [])
  assert.deepEqual(await readdir(join(work, 'out')), [])
})

test('a run ends with why it failed, and is ended, not finished, until a finish gives that back', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const sessions = new FakeSessions()
  const service = make(work, () => {}, sessions, new FakeBoxes(work))
  const { sessionId } = await startIn(service, HOST, tauDir, values, work)
  sessions.end(sessionId, { end: { kind: 'error', error: { message: 'rate limited' } }, text: 'Half' })
  await service.close()
  const later = make(work, () => {}, sessions, new FakeBoxes(work))
  // As fleet-tau-runs loads them, before the service.
  await later.tauRuns.load()
  await later.load()
  const failed = { ok: false, text: 'Half', failure: 'the run failed: rate limited' }
  assert.deepEqual(await finish(later, HOST, sessionId), failed)
  const [status] = await later.list(HOST)
  assert.equal(status?.state, 'finished')
})

test('cancelling cancels a run\'s turn while it runs, and not once it ended', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const sessions = new FakeSessions()
  const service = make(work, () => {}, sessions, new FakeBoxes(work))
  const { sessionId } = await startIn(service, HOST, tauDir, values, work)
  sessions.calls.length = 0
  await service.cancel(HOST, sessionId)
  sessions.end(sessionId, { end: { kind: 'aborted' }, text: '' })
  assert.deepEqual(await finish(service, HOST, sessionId), { ok: false, text: '', failure: 'the run was cancelled' })
  await service.cancel(HOST, sessionId)
  assert.deepEqual(sessions.calls, [`cancel ${sessionId}`])
})

test('giving up a finish leaves the run running', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const sessions = new FakeSessions()
  const service = make(work, () => {}, sessions, new FakeBoxes(work))
  const { sessionId } = await startIn(service, HOST, tauDir, values, work)
  const waiting = new AbortController()
  const finishing = service.finish(HOST, sessionId, waiting.signal)
  waiting.abort(new Error('gone'))
  await assert.rejects(finishing, /gone/u)
  assert.equal((await service.status(HOST, sessionId)).state, 'running')
  sessions.end(sessionId, completed('Done.'))
  assert.deepEqual(await finish(service, HOST, sessionId), { ok: true, text: 'Done.' })
})

test('a start that fails on the way archives the session, and removes its box and its entry', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  sessions.failing = 'prompt'
  await assert.rejects(startIn(service, HOST, tauDir, values, work), /prompt failed/u)
  assert.deepEqual(sessions.calls.map(call => call.split(' ')[0]), ['create', 'prompt', 'archive'])
  assert.equal(boxes.calls.at(-1), 'remove')
  assert.deepEqual(await service.list(HOST), [])
})

test('a service started later watches the runs that had not ended, and fails one that never got its prompt', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions(), new FakeBoxes(work))
  const { sessionId: running } = await startIn(service, HOST, tauDir, values, work)
  // As a host that stopped between setting up the box and prompting the session leaves it.
  const { sessionId: unprompted } = await create(service, tauDir, values, work)
  await service.close()

  // dsh closes a turn a stop cut short as interrupted.
  const sessions = new FakeSessions()
  sessions.end(running, { end: { kind: 'interrupted' }, text: '' })
  const later = make(work, () => {}, sessions, new FakeBoxes(work))
  // As fleet-tau-runs loads them, before the service.
  await later.tauRuns.load()
  await later.load()
  assert.deepEqual(await finish(later, HOST, running), { ok: false, text: '', failure: 'the fleet host stopped during the run' })
  assert.deepEqual(await finish(later, HOST, unprompted), { ok: false, text: '', failure: 'the fleet host stopped before the run got its prompt' })
  assert.deepEqual((await later.list(HOST)).map(status => status.sessionId), [running, unprompted])
})

test('deleting archives the session before it removes the box, and a failed archive keeps both', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId, box } = await startIn(service, HOST, tauDir, values, work)
  sessions.calls.length = 0

  sessions.failing = 'archive'
  await assert.rejects(service.delete(HOST, sessionId), /archive failed/u)
  assert.ok(boxes.existing.has(box))
  await new Registry(join(work, 'taus')).get(sessionId)

  await service.delete(HOST, sessionId)
  assert.ok(!boxes.existing.has(box))
  assert.deepEqual(sessions.calls, [`archive ${sessionId}`, `archive ${sessionId}`])
  // Its agent stops with the archive; nothing is recorded of a run that is gone.
  sessions.end(sessionId, completed('Done.'))
  await assert.rejects(service.finish(HOST, sessionId, new AbortController().signal), /no tau session/u)
  await service.close()
  assert.deepEqual(await readdir(join(work, 'taus')), [])
})

/** A tau's session as the caller of the runs it starts from its box. */
function from(sessionId: string): Caller {
  return { kind: 'session', sessionId }
}

test('a tau\'s session starts a run from its box as the host does, in its own project, and another session in the project it names', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions(), new FakeBoxes(work))
  const { sessionId: parent } = await startIn(service, HOST, tauDir, values, work)
  const elsewhere = await mkdtemp(join(tmpdir(), 'fleet-tau-elsewhere-'))
  t.after(() => rm(elsewhere, { recursive: true, force: true }))
  // What a session names as its project is not its runs'.
  const { about, archive } = callOf(tauDir, values, work)
  const { sessionId: child, prompt } = await service.start(from(parent), { ...about, project: elsewhere }, archive)
  assert.equal(prompt, EXPANDED)
  const entry = await new Registry(join(work, 'taus')).get(child)
  assert.deepEqual(entry.caller, from(parent))
  assert.equal(entry.project, await realpath(work))
  assert.equal((await service.status(HOST, child)).parent, parent)
  // A session that is no tau's, as with tau_run, names its project, as the host does.
  const other = 'session-00000000-0000-4000-8000-000000000000'
  const { sessionId: own } = await startIn(service, from(other), tauDir, values, work)
  assert.equal((await new Registry(join(work, 'taus')).get(own)).project, await realpath(work))
  assert.equal((await service.status(HOST, own)).parent, other)
  await assert.rejects(service.start(from(other), { title: 'tau', targets: {} }, callOf(tauDir, values, work).archive), /names its project, an absolute path/u)
})

test('a tau\'s session reaches only the runs it started, and the host every run', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions(), new FakeBoxes(work))
  const { sessionId: parent } = await startIn(service, HOST, tauDir, values, work)
  const { sessionId: other } = await startIn(service, HOST, tauDir, values, work)
  const { sessionId: child } = await startIn(service, from(parent), tauDir, values, work)
  assert.deepEqual((await service.list(from(parent))).map(status => status.sessionId), [child])
  assert.deepEqual(await service.list(from(other)), [])
  assert.deepEqual((await service.list(HOST)).map(status => status.sessionId), [parent, other, child])
  const signal = new AbortController().signal
  const reaches = [
    () => service.status(from(other), child), () => service.finish(from(other), child, signal), () => service.cancel(from(other), child),
    () => service.delete(from(other), child), () => service.status(from(child), parent),
  ]
  for (const reach of reaches) await assert.rejects(reach, new RegExp(`no tau session (${child}|${parent})`, 'u'))
  assert.equal((await service.status(from(parent), child)).state, 'running')
})

test('a run\'s end deletes the runs it started and did not finish, and its deletion every run it started', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId: parent } = await startIn(service, HOST, tauDir, values, work)
  const { sessionId: finished } = await startIn(service, from(parent), tauDir, values, work)
  const { sessionId: running } = await startIn(service, from(parent), tauDir, values, work)
  const { sessionId: grandchild } = await startIn(service, from(running), tauDir, values, work)
  sessions.end(finished, completed('Done.'))
  await finish(service, from(parent), finished)
  sessions.calls.length = 0

  sessions.end(parent, completed('Done.'))
  await finish(service, HOST, parent)
  while ((await service.list(HOST)).length > 2) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual((await service.list(HOST)).map(status => status.sessionId), [parent, finished])
  assert.deepEqual(sessions.calls.sort(), [`archive ${grandchild}`, `archive ${running}`].sort())

  await service.delete(HOST, parent)
  assert.deepEqual(await service.list(HOST), [])
})

test('a tau session\'s box is started for its files and processes once, and again after a stop', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, new FakeSessions(), boxes)
  const { sessionId, box } = await create(service, tauDir, values, work)
  boxes.calls.length = 0

  assert.equal(await service.tauRuns.boxFor('session-00000000-0000-4000-8000-000000000000'), undefined)
  assert.equal(await service.tauRuns.boxFor('not-a-tau-session'), undefined)
  const [first, second] = await Promise.all([service.tauRuns.boxFor(sessionId), service.tauRuns.boxFor(sessionId)])
  assert.equal(first?.container, box)
  assert.equal(first, second)
  await service.tauRuns.stop(sessionId)
  assert.equal((await service.tauRuns.boxFor(sessionId))?.container, box)
  assert.deepEqual(boxes.calls, ['start', 'stop', 'start'])
  await service.tauRuns.close()
  assert.deepEqual(boxes.calls, ['start', 'stop', 'start', 'stop'])

  // As after a restart: the registry says which sessions are a tau's, and where their boxes are.
  const later = make(work, () => {}, new FakeSessions(), boxes)
  assert.equal(later.tauRuns.isTau(sessionId), false)
  await later.tauRuns.load()
  assert.equal(later.tauRuns.isTau(sessionId), true)
  boxes.calls.length = 0
  await later.tauRuns.boxFor(sessionId)
  assert.deepEqual(boxes.calls, [`open ${box}`, 'start'])
  await later.delete(HOST, sessionId)
  assert.equal(later.tauRuns.isTau(sessionId), false)
  assert.equal(await later.tauRuns.boxFor(sessionId), undefined)
})

test('a host file is copied into a tau session\'s box once, before the box\'s next use, and again after a failure', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const boxes = new FakeBoxes(work)
  const logged: string[] = []
  const service = make(work, message => logged.push(message), new FakeSessions(), boxes)
  const { sessionId } = await create(service, tauDir, values, work)
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
  const boxes = new FakeBoxes(work)
  const { sessionId, box } = await create(make(work, () => {}, new FakeSessions(), boxes), tauDir, values, work)
  boxes.existing.delete(box)
  const service = make(work, () => {}, new FakeSessions(), boxes)
  await assert.rejects(service.tauRuns.start(sessionId), /No such container/u)
  await service.delete(HOST, sessionId)
  await assert.rejects(service.status(HOST, sessionId), /no tau session/u)
})

test('a tau session\'s project, where dsh runs its work, is /tau/workspace in its box', async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions(), new FakeBoxes(work))
  const { sessionId } = await create(service, tauDir, values, work)
  const project = await realpath(work)
  const { boxPath } = service.tauRuns
  assert.equal(boxPath.call(service.tauRuns, sessionId, project), '/tau/workspace')
  assert.equal(boxPath.call(service.tauRuns, sessionId, `${project}/site/index.md`), '/tau/workspace/site/index.md')
  assert.equal(boxPath.call(service.tauRuns, sessionId, `${project}-other/a`), `${project}-other/a`)
  assert.equal(boxPath.call(service.tauRuns, sessionId, '/tau/out/report.md'), '/tau/out/report.md')
  assert.equal(boxPath.call(service.tauRuns, 'not-a-tau-session', project), project)
  // As after a restart: the registry gives each session's project.
  const later = make(work, () => {}, new FakeSessions(), new FakeBoxes(work))
  await later.tauRuns.load()
  assert.equal(later.tauRuns.boxPath(sessionId, project), '/tau/workspace')
})

test('only ids of the form the service mints name sessions', async (t) => {
  const { work } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions(), new FakeBoxes(work))
  for (const id of ['../../etc/passwd', 'session-1', '']) {
    await assert.rejects(service.status(HOST, id), new RegExp(`no tau session ${id.replaceAll('.', '\\.')}`, 'u'))
  }
})

/** Why the test needs an image that is not there, or false. */
async function absent(image: string): Promise<string | false> {
  return run('docker', ['image', 'inspect', image]).then(() => false, () => `no Docker image ${image}; build it with \`pnpm image\``)
}

test('a real box places a call\'s handles and the tau, and packs what its agent left', { skip: await absent(DEFAULT_IMAGE) }, async (t) => {
  const { work, tauDir, values } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions())
  const { about, archive } = callOf(tauDir, values, work)
  const { sessionId, box, prompt } = await service.tauRuns.create(archive, about)
  try {
    assert.equal(prompt, EXPANDED)
    await service.tauRuns.start(sessionId)
    const { stdout } = await run('docker', ['exec', box, 'find', '/tau', '-path', '/tau/node_modules', '-prune', '-o', '-not', '-type', 'd', '-print'])
    assert.deepEqual(stdout.trim().split('\n').sort(), [
      '/tau/.run.json', '/tau/in/notes.md', '/tau/self/PROMPT.md', '/tau/self/api/notes/index.d.ts', '/tau/self/tau.json', '/tau/workspace/site/index.md',
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
    const params = { root: '/tau', modules: modulesOf(entry), cwd: service.tauRuns.boxPath(sessionId, entry.project) }
    const source = 'import { add } from "@api/notes"\nexport async function main(input: string): Promise<void> { await add(input) }'
    const outcome = await started?.request('ts.execute', { ...params, execution: 'e1', source, input: 'eggs' })
    assert.deepEqual({ ...outcome, durationMs: 0 }, { ok: true, value: null, stdout: '', stderr: '', durationMs: 0 })
    assert.deepEqual(added.at(-1), { args: ['eggs'], sessionId })
    const mistaken = await started?.request('ts.execute', { ...params, execution: 'e2', source: 'import { add } from "@api/notes"\nexport function main(): void { add(1) }' })
    assert.equal(mistaken?.ok === false && mistaken.error.name, 'TypeCheckError')
    assert.equal((await run('docker', ['exec', box, 'cat', '/tau/in/notes.md'])).stdout, 'buy milk\n')
    await run('docker', ['exec', box, 'test', '-d', '/tau/out/pages'])
    // The caller's folder, where dsh runs the session's work, is /tau/workspace in the box, and not there at its own path.
    await assert.rejects(run('docker', ['exec', box, 'test', '-e', await realpath(work)]))

    // A link that leads out of its handle fails the run, in the box.
    const exec = async (script: string): Promise<void> => { assert.equal((await started?.request('exec', { argv: ['sh', '-c', script] }))?.code, 0) }
    await exec('echo Added. > /tau/out/report.md && echo A > /tau/out/pages/a.md && ln -s /etc/passwd /tau/out/pages/leak')
    const leaked = await service.tauRuns.pack(sessionId, { ok: true, text: 'Done.' })
    assert.match(leaked.failure ?? '', /^the run did not leave what the tau declares:\n {2}pages: \/tau\/out\/pages\/leak: leads to the absolute path \/etc\/passwd/u)
    // What the agent leaves is packed in the box, read and checked here, and put at the caller's paths by the caller.
    await exec('rm /tau/out/pages/leak && ln -s a.md /tau/out/pages/latest && echo more >> /tau/workspace/site/index.md')
    assert.deepEqual(await service.tauRuns.pack(sessionId, { ok: true, text: 'Done.' }), { ok: true, text: 'Done.' })
    assert.deepEqual(await applyResult(await service.tauRuns.result(sessionId), entry.targets), { ok: true, text: 'Done.' })
    assert.equal(await readFile(join(work, 'out', 'report.md'), 'utf8'), 'Added.\n')
    assert.equal(await readlink(join(work, 'out', 'pages', 'latest')), 'a.md')
    assert.equal(await readFile(join(work, 'site', 'index.md'), 'utf8'), '# Home\nmore\n')
    assert.equal(await readFile(join(work, 'notes.md'), 'utf8'), 'buy milk\n')
    await service.tauRuns.stop(sessionId)
  } finally {
    await service.delete(HOST, sessionId)
  }
  await assert.rejects(run('docker', ['container', 'inspect', box]), /No such container/u)
})
