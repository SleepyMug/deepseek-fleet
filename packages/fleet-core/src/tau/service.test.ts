import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { type CallFile, checkInputs, type Delivery, type Envelope, kindAt, loadTau, type Report } from '@sleepymug/tau/core'
import { createFleetAdaptor, fleetLoopback } from '@sleepymug/tau/adaptors'
import { readContents } from '@sleepymug/tau/transfer'
import { encodeCall, packCall, packResult, unpackResult } from '@sleepymug/tau/wire-tar'
import type { Result, RunStatus } from '@sleepymug/fleet-protocol/tau'
import { DEFAULT_IMAGE } from '@sleepymug/fleet-box-runtime/layout'
import { pack, setup } from '@sleepymug/fleet-box-runtime/tau/endpoint'
import { readTauCommand } from '@sleepymug/fleet-box-runtime/tau/protocol'
import type { CallHandler } from '../box/helper.ts'
import { FleetExts } from '../ext/exts.ts'
import { systemPlatform } from '../platform.ts'
import { abortable } from '../util/abort.ts'
import type { Exts } from './apis.ts'
import type { RunBox, Started } from './ports.ts'
import { HOST, Registry, type Caller } from './registry.ts'
import { TauRuns } from './runs.ts'
import type { Boxes } from './session-box.ts'
import { TauService, TRACE_FORMAT, type Sessions } from './service.ts'

const run = promisify(execFile)

const PROMPT = 'Add ${notes} to ${site} in a ${style} style, then write ${report} and fill ${pages}. You are ${self}.\n'
const EXPANDED = 'Add /tau/in/notes.md to /tau/workspace/site in a terse style, then write /tau/out/report.md and fill /tau/out/pages. You are /tau/self.\n'

/** A folder with a tau that takes a file of each mode, and the caller's files for it. */
async function fixture(t: { after(fn: () => Promise<void>): void }): Promise<{ work: string; tauDir: string; call: { files: Record<string, string>; args: Record<string, unknown> } }> {
  const work = await mkdtemp(join(tmpdir(), 'fleet-tau-test-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const tauDir = join(work, 'tau')
  await mkdir(tauDir)
  await writeFile(join(tauDir, 'PROMPT.md'), PROMPT)
  await writeFile(join(tauDir, 'tau.json'), JSON.stringify({
    files: {
      notes: { kind: 'file', mode: 'in', description: 'What to add.' },
      site: { kind: 'dir', mode: 'inout', description: 'The pages.' },
      report: { kind: 'file', mode: 'out', description: 'What changed.' },
      pages: { kind: 'dir', mode: 'out', description: 'New pages.' },
    },
    args: { type: 'object', properties: { style: { type: 'string', description: 'How to write.' } }, required: ['style'] },
    // The contract @test/notes, which programs import by its name.
    apis: { '@test/notes': '^1.2.0' },
  }))
  // The contract, at the version make()'s extension implements, with more than its declarations.
  await mkdir(join(work, 'contract', 'lib'), { recursive: true })
  await writeFile(join(work, 'contract', 'package.json'), JSON.stringify({
    name: '@test/notes', version: '1.3.0', description: 'Notes.', tau: { contract: true }, type: 'module', types: './index.d.ts',
  }))
  await writeFile(join(work, 'contract', 'index.d.ts'), 'export declare function add(text: string): void;\n')
  await writeFile(join(work, 'contract', 'lib', 'tags.d.ts'), 'export type Tag = string;\n')
  await writeFile(join(work, 'contract', 'README.md'), 'Notes.\n')
  // The client of the extension that implements @test/notes, which make()'s extensions provide.
  await mkdir(join(work, 'client'))
  await writeFile(join(work, 'client', 'index.js'), 'import { call } from "@sleepymug/fleet-box-runtime/ext/client";\nexport function add(text) { return call("@test/notes", "add", [text]); }\n')
  await writeFile(join(work, 'notes.md'), 'buy milk\n')
  await mkdir(join(work, 'site'))
  await writeFile(join(work, 'site', 'index.md'), '# Home\n')
  await mkdir(join(work, 'out'))
  const call = { files: { notes: 'notes.md', site: 'site', report: 'out/report.md', pages: 'out/pages' }, args: { style: 'terse' } }
  return { work, tauDir, call }
}

/**
 * What the agent leaves in the box, by path: a file's text, or null for a
 * folder. By default, what the fixture's tau declares at the places of its
 * `out` and `inout` files.
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
  tamper: ((outcome: Result, files: Envelope['files']) => AsyncIterable<Uint8Array>) | undefined
  /** How a process a box spawns, such as a run's init, ends, after writing what it writes: by default at once, with 0, writing nothing. */
  spawn: (params: { argv: string[]; cwd: string }, write: (stream: 'stdout' | 'stderr', text: string) => void) => Promise<{ code: number | null; signal: string | null }> =
    async () => ({ code: 0, signal: null })
  /** What a box's `kill` of a process does, besides being recorded. */
  kill: () => void = () => {}

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
        await rm(this.root(name), { recursive: true, force: true })
      },
      copyIn: async (from, to) => {
        record('copyIn', `copyIn ${from.replace(/\/contract-[^/]+\//u, '/contract-…/')} ${to}`)
        await cp(from, join(this.root(name), to), { recursive: true })
      },
      pipe: async (argv, io) => {
        const command = readTauCommand(argv.slice(2))
        record('pipe', `pipe ${command.command}`)
        const root = this.root(name)
        if (command.command === 'setup') {
          const report = await setup(io?.input ?? Readable.from([]), command.offered, root)
          await pipeline(Readable.from([JSON.stringify(report)]), io?.output ?? process.stdout)
          return
        }
        const { outcome } = command
        const { files } = JSON.parse(await readFile(join(root, '/tau/.run.json'), 'utf8')) as { files: Envelope['files'] }
        for (const [path, text] of Object.entries(this.left).sort(([a], [b]) => a.localeCompare(b))) {
          const at = join(root, path)
          if (text === null) await mkdir(at, { recursive: true })
          else await mkdir(dirname(at), { recursive: true }).then(() => writeFile(at, text))
        }
        await pipeline(Readable.from(this.tamper?.(outcome, files) ?? await pack(outcome, root)), io?.output ?? process.stdout)
      },
      request: (async (method: string, params: unknown, onEvent?: (event: unknown) => void) => {
        record(method, `${method} ${JSON.stringify(params)}`)
        if (method === 'spawn') {
          return await this.spawn(params as { argv: string[]; cwd: string }, (stream, text) => { onEvent?.({ stream, data: Buffer.from(text).toString('base64') }) })
        }
        if (method === 'kill') this.kill()
        return { code: 0, signal: null, stdout: '', stderr: '' }
      }) as RunBox['request'],
    }
  }
}

/** What the extension of @test/notes, as make() provides it, was called with. */
const added: { args: unknown[]; sessionId: string }[] = []

/**
 * The tau service on runs in `work`, with the runs at hand, and, unless
 * `exts` says otherwise, an extension of @test/notes whose client is the
 * fixture's, and whose `add` records its call.
 */
function make(work: string, log: (message: string) => void, sessions: Sessions, boxes?: Boxes, exts?: Exts, idleStopMs?: number): TauService & { tauRuns: TauRuns } {
  let provided = exts
  if (provided === undefined) {
    const own = new FleetExts()
    own.provide({
      contract: '@test/notes',
      version: '1.3.0',
      client: join(work, 'client'),
      declarations: join(work, 'contract'),
      methods: {
        add: (args, { sessionId }) => {
          added.push({ args, sessionId })
          return `added ${String(args[0])}`
        },
      },
    })
    provided = own
  }
  const platform = systemPlatform(log)
  const runs = new TauRuns({ registry: new Registry(join(work, 'taus')), exts: provided, platform, ...boxes === undefined ? {} : { boxes }, ...idleStopMs === undefined ? {} : { idleStopMs } })
  return Object.assign(new TauService({ runs, sessions, platform }), { tauRuns: runs })
}

/**
 * A call of the tau at `tauDir`, packed in `cwd`, as tau's client packs it
 * for its fleet adaptor, with what the submit says of it, and where the
 * caller has its outputs.
 */
function callOf(tauDir: string, call: unknown, cwd: string): { about: { title: string; project: string }; archive: AsyncIterable<Uint8Array>; delivery: Delivery } {
  const tau = loadTau(tauDir)
  const resolved = tau.resolve(call, cwd)
  checkInputs(resolved)
  const files: Record<string, CallFile> = {}
  const inputs: Record<string, string | readonly string[]> = {}
  const targets: Record<string, string> = {}
  for (const [name, file] of Object.entries(resolved.files)) {
    const from = resolved.paths[name] as string | readonly string[]
    if (file.mode !== 'in') targets[name] = from as string
    if (file.mode === 'out') {
      files[name] = file
      continue
    }
    files[name] = { ...file, kind: typeof from === 'string' ? kindAt(from) : 'dir' }
    inputs[name] = from
  }
  return {
    about: { title: basename(tau.dir), project: cwd },
    archive: packCall({ envelope: { files, args: resolved.args }, tau: tau.dir, inputs }),
    delivery: { files, targets },
  }
}

/** Where the caller of each run started here has its outputs, by its session. */
const deliveries = new Map<string, Delivery>()

/** Submit a run of the tau at `tauDir` for `call`, packed in `cwd`, as a caller does. */
async function startIn(service: TauService, caller: Caller, tauDir: string, call: unknown, cwd: string): Promise<Started> {
  const { about, archive, delivery } = callOf(tauDir, call, cwd)
  const started = await service.submit(caller, about, archive)
  deliveries.set(started.sessionId, delivery)
  return started
}

/** Set up a run's box for the tau at `tauDir` for `call`, packed in `cwd`. */
async function create(service: { tauRuns: TauRuns }, tauDir: string, call: unknown, cwd: string): Promise<Started> {
  const { about, archive, delivery } = callOf(tauDir, call, cwd)
  const started = await service.tauRuns.create(archive, about)
  deliveries.set(started.sessionId, delivery)
  return started
}

/** How a run ended, as a report has it. */
function resultOf({ ok, text, failure }: Report): Result {
  return failure === undefined ? { ok, text } : { ok, text, failure }
}

/** Put a run's result at its caller's paths, as tau's fleet adaptor does, and give back how it ended. */
async function deliver(sessionId: string, archive: AsyncIterable<Uint8Array>): Promise<Result> {
  const delivery = deliveries.get(sessionId)
  assert.ok(delivery !== undefined, `no caller of ${sessionId}`)
  return resultOf(await unpackResult(archive, delivery))
}

/**
 * Finish a run as a caller does: wait for it, take its result, numbered 1,
 * put what it gave back where its caller has its outputs, and give back how
 * it ended, which its status, and the service's list, agree with.
 */
async function finish(service: TauService, caller: Caller, sessionId: string): Promise<Result> {
  await service.untilEnded(caller, sessionId, new AbortController().signal)
  const { value, body } = await service.result(caller, sessionId)
  assert.deepEqual(value, { result: 1 })
  const result = await deliver(sessionId, body)
  const { ok, failure } = result
  assert.deepEqual(await service.status(HOST, sessionId), { state: 'ended', result: 1, ok, ...failure === undefined ? {} : { failure } })
  assert.deepEqual((await listed(service, sessionId)).result, result)
  return result
}

/** A run, as the service's list gives it. */
async function listed(service: TauService, sessionId: string): Promise<RunStatus> {
  const found = (await service.list(HOST)).find(status => status.sessionId === sessionId)
  assert.ok(found !== undefined, `${sessionId} is not listed`)
  return found
}

/** How a run's agent ended, as dsh's log has it, for a turn that completed with this text. */
function completed(text: string): Result {
  return { ok: true, text }
}

/**
 * dsh's sessions, as a record of what is done with them, with the call
 * `failing` names failing once. A session's agent is at work until the test
 * ends it, with {@link end}.
 */
class FakeSessions implements Sessions {
  readonly calls: string[] = []
  failing: string | undefined
  private readonly ends = new Map<string, PromiseWithResolvers<Result>>()

  create(sessionId: string, project: string, title: string): Promise<void> {
    return this.record('create', `create ${sessionId} ${project} ${title}`)
  }

  prompt(sessionId: string, requestId: string, text: string): Promise<void> {
    return this.record('prompt', `prompt ${sessionId} ${requestId} ${text}`)
  }

  archive(sessionId: string): Promise<void> {
    return this.record('archive', `archive ${sessionId}`)
  }

  settled(sessionId: string, signal: AbortSignal): Promise<Result> {
    return abortable(this.ending(sessionId).promise, signal)
  }

  history(sessionId: string): Promise<unknown[]> {
    return Promise.resolve([{ type: 'user/message', sessionId }, { type: 'turn/end', sessionId }])
  }

  /** End a session's agent's work, as it ended. */
  end(sessionId: string, result: Result): void {
    this.ending(sessionId).resolve(result)
  }

  private ending(sessionId: string): PromiseWithResolvers<Result> {
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

test('setting up a run\'s box reads its call, has the box place the files, copies in the tau, leaves the box stopped, and registers the session', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const boxes = new FakeBoxes(work)
  const logged: string[] = []
  const service = make(work, (message) => { logged.push(message) }, new FakeSessions(), boxes)

  const created = await create(service, tauDir, call, work)
  const project = await realpath(work)
  assert.match(created.sessionId, /^session-[0-9a-f-]{36}$/u)
  assert.equal(created.box, `fleet-tau-${created.sessionId.slice('session-'.length)}`)
  assert.equal(created.prompt, EXPANDED)
  assert.deepEqual(boxes.calls, [
    `create ${created.box}`,
    'start',
    'pipe setup',
    `copyIn ${join(work, 'client')} /tau/node_modules/.fleet/@test/notes`,
    `copyIn ${join(work, 'taus', created.sessionId, 'contract-…', 'contract')} /tau/node_modules/.contracts/@test/notes`,
    `apis.link ${JSON.stringify({
      modules: '/tau/node_modules',
      apis: [{ name: '@test/notes', client: '/tau/node_modules/.fleet/@test/notes', types: '/tau/node_modules/.contracts/@test/notes' }],
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
  // The contract as the extension has it, its package.json and declarations alone.
  assert.deepEqual((await readdir(join(root, 'tau/node_modules/.contracts/@test/notes'), { recursive: true })).sort(), ['index.d.ts', 'lib', 'lib/tags.d.ts', 'package.json'])
  // The call is kept; the tau read from it here is gone.
  assert.deepEqual(await readdir(join(work, 'taus', created.sessionId)), ['call.tar'])

  const entry = await new Registry(join(work, 'taus')).get(created.sessionId)
  assert.equal(entry.box, created.box)
  assert.equal(entry.title, 'tau')
  assert.equal(entry.project, project)
  assert.equal(entry.prompt, EXPANDED)
  assert.match(entry.promptRequestId, /^[0-9a-f-]{36}$/u)
  assert.equal(entry.promptedAt, undefined)
  assert.deepEqual(entry.apis, ['@test/notes'])
  assert.deepEqual(entry.exposed, [{ specifier: '@test/notes', description: 'Notes.', declarations: '/tau/node_modules/.contracts/@test/notes' }])
  assert.deepEqual(entry.skills, [])
  assert.deepEqual(entry.files, {
    notes: { mode: 'in', kind: 'file', base: 'notes.md', description: 'What to add.', place: '/tau/in/notes.md' },
    site: { mode: 'inout', kind: 'dir', base: 'site', description: 'The pages.', place: '/tau/workspace/site' },
    report: { mode: 'out', kind: 'file', base: 'report.md', description: 'What changed.', place: '/tau/out/report.md' },
    pages: { mode: 'out', kind: 'dir', base: 'pages', description: 'New pages.', place: '/tau/out/pages' },
  })
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

test('submit refuses a call that breaks the spec, or that does not fit the tau, before it makes a box', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, new FakeSessions(), boxes)
  const about = { title: 'tau', project: work }
  const whole = await bytesOf(callOf(tauDir, call, work).archive)
  await assert.rejects(service.submit(HOST, about, once(whole.subarray(0, 1024))), /^Error: the call breaks the spec: /u)
  const unfit = encodeCall({ files: {}, args: { style: 'terse' } }, readContents([{ from: tauDir }]))
  await assert.rejects(service.submit(HOST, about, unfit), /^Error: fleet: the call does not fit the tau:\n {2}no path for notes, site, report, pages$/u)
  // A tau's problems name it by the run's title.
  await mkdir(join(work, 'empty'))
  const empty = encodeCall({ files: {}, args: {} }, readContents([{ from: join(work, 'empty') }]))
  await assert.rejects(service.submit(HOST, { ...about, title: 'mine' }, empty), /^Error: fleet: the tau mine: not a tau \(no PROMPT\.md\)$/u)
  // A tau whose links lead out of it is no content of a call.
  await symlink('/etc/passwd', join(tauDir, 'leak.md'))
  await assert.rejects(service.submit(HOST, about, encodeCall({ files: {}, args: {} }, readContents([{ from: tauDir }]))),
    /the call breaks the spec: tau\/leak\.md: leads to the absolute path \/etc\/passwd/u)
  await assert.rejects(service.submit(HOST, { ...about, project: 'here' }, once(whole)), /names its project, an absolute path/u)
  assert.deepEqual(boxes.calls, [])
  assert.deepEqual(await readdir(join(work, 'taus')), [])
})

test('submit refuses a tau with an API whose contract no extension implements, or at no version within its range, before it makes a box', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const boxes = new FakeBoxes(work)
  const none = make(work, () => {}, new FakeSessions(), boxes, new FleetExts())
  await assert.rejects(startIn(none, HOST, tauDir, call, work), /^Error: fleet: no implementation serves:\n {2}@test\/notes@\^1\.2\.0$/u)
  const older = new FleetExts()
  older.provide({ contract: '@test/notes', version: '1.1.0', client: join(work, 'client'), declarations: join(work, 'contract'), methods: {} })
  await assert.rejects(startIn(make(work, () => {}, new FakeSessions(), boxes, older), HOST, tauDir, call, work),
    /^Error: fleet: no implementation serves:\n {2}@test\/notes@\^1\.2\.0$/u)
  assert.deepEqual(boxes.calls, [])
})

test('the service gives the contract an extension implements, the newest within a range, its package.json and declarations, to any caller', async (t) => {
  const { work } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions(), new FakeBoxes(work))
  const adaptor = createFleetAdaptor({ transport: fleetLoopback(service.handlerFor({ kind: 'session', sessionId: 'session-other' })) })
  const at = join(work, 'pulled')
  assert.deepEqual(await adaptor.contract?.('@test/notes', '^1.2.0', at), { name: '@test/notes', version: '1.3.0', description: 'Notes.' })
  assert.deepEqual((await readdir(at, { recursive: true })).sort(), ['index.d.ts', 'lib', 'lib/tags.d.ts', 'package.json'])
  await assert.rejects(adaptor.contract?.('@test/notes', '^1.4.0', join(work, 'none')) ?? Promise.resolve(), /^Error: fleet: no extension implements @test\/notes within \^1\.4\.0 now$/u)
  await assert.rejects(adaptor.contract?.('@test/other', undefined, join(work, 'none')) ?? Promise.resolve(), /no extension implements @test\/other now/u)
})

test('the calls of a session\'s clients go to the extension\'s server, as that session\'s, for the contracts its tau names', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, new FakeSessions(), boxes)
  const { sessionId } = await create(service, tauDir, call, work)
  assert.equal(boxes.onCall, undefined)
  await service.tauRuns.start(sessionId)
  const signal = new AbortController().signal
  // Set by the start, which TypeScript does not see.
  const onCall = boxes.onCall as CallHandler | undefined
  assert.ok(onCall !== undefined)
  added.length = 0
  assert.equal(await onCall({ contract: '@test/notes', method: 'add', args: ['milk'] }, signal), 'added milk')
  assert.deepEqual(added, [{ args: ['milk'], sessionId }])
  await assert.rejects(onCall({ contract: '@test/notes', method: 'toString', args: [] }, signal), /the extension of @test\/notes has no method toString/u)
  // By its contract's name alone.
  await assert.rejects(onCall({ contract: 'notes', method: 'add', args: [] }, signal), /names no API notes/u)
})

test('a set-up that fails removes its box and registers nothing', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const boxes = new FakeBoxes(work)
  boxes.failing = 'copyIn'
  const service = make(work, () => {}, new FakeSessions(), boxes)
  await assert.rejects(startIn(service, HOST, tauDir, call, work), /copyIn failed/u)
  assert.equal(boxes.calls.at(-1), 'remove')
  assert.equal(boxes.existing.size, 0)
  assert.deepEqual(await readdir(join(work, 'taus')), [])
})

test('a run starts its box, makes the dsh session in the caller\'s folder with the prompt, and ends once its agent is done', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId } = await startIn(service, HOST, tauDir, call, work)
  const { promptRequestId, project } = await new Registry(join(work, 'taus')).get(sessionId)
  assert.deepEqual(boxes.calls.slice(-2), ['stop', 'start'])
  assert.deepEqual(sessions.calls, [`create ${sessionId} ${project} tau`, `prompt ${sessionId} ${promptRequestId} ${EXPANDED}`])
  assert.notEqual((await new Registry(join(work, 'taus')).get(sessionId)).promptedAt, undefined)
  assert.deepEqual({ ...await listed(service, sessionId), createdAt: '' }, { sessionId, title: 'tau', project, prompt: EXPANDED, state: 'running', createdAt: '' })
  assert.deepEqual(await service.status(HOST, sessionId), { state: 'running' })

  const finishing = finish(service, HOST, sessionId)
  sessions.end(sessionId, completed('Done.'))
  assert.deepEqual(await finishing, { ok: true, text: 'Done.' })
  assert.equal(boxes.calls.at(-1), 'stop')
  const status = await listed(service, sessionId)
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

test('a run that succeeded gives back what its agent left, packed by its box, for its caller to put at its paths', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  await writeFile(join(work, 'site', 'kept.md'), 'kept\n')
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId } = await startIn(service, HOST, tauDir, call, work)
  sessions.end(sessionId, completed('Done.'))
  // Ended, packed and checked, and kept for each finish.
  while ((await service.status(HOST, sessionId)).state === 'running') await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await service.status(HOST, sessionId), { state: 'ended', result: 1, ok: true })
  assert.deepEqual(boxes.calls.filter(call => call.startsWith('pipe')), ['pipe setup', 'pipe pack'])
  assert.deepEqual(await readdir(join(work, 'taus', sessionId)), ['call.tar', 'result.tar'])

  // The service puts nothing at the caller's paths, which it never learns; the caller's adaptor does.
  const { body: archive } = await service.result(HOST, sessionId)
  await assert.rejects(readFile(join(work, 'out', 'report.md')), /ENOENT/u)
  const result = await deliver(sessionId, archive)
  assert.deepEqual(result, { ok: true, text: 'Done.' })
  assert.equal(await readFile(join(work, 'out', 'report.md'), 'utf8'), 'Added milk.\n')
  assert.deepEqual(await readdir(join(work, 'out', 'pages')), ['a.md'])
  assert.deepEqual((await readdir(join(work, 'site'))).sort(), ['index.md', 'kept.md', 'milk.md'])
  assert.equal(await readFile(join(work, 'site', 'index.md'), 'utf8'), '# Home\n\nbuy milk\n')
  assert.deepEqual(await finish(service, HOST, sessionId), result)
  assert.deepEqual(await readdir(join(work, 'taus', sessionId)), ['call.tar', 'result.tar'])
})

test('a run\'s trace, its session\'s events, is given back, ended or not, failed or not, to whoever reaches the run', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const service = make(work, () => {}, sessions, new FakeBoxes(work))
  const { sessionId } = await startIn(service, HOST, tauDir, call, work)
  const signal = new AbortController().signal
  const trace = { format: TRACE_FORMAT, events: [{ type: 'user/message', sessionId }, { type: 'turn/end', sessionId }] }
  assert.deepEqual(await service.trace(HOST, sessionId, signal), trace)
  sessions.end(sessionId, { ok: false, text: '', failure: 'the run was cancelled' })
  assert.deepEqual(await finish(service, HOST, sessionId), { ok: false, text: '', failure: 'the run was cancelled' })
  assert.deepEqual(await service.trace(HOST, sessionId, signal), trace)
  await assert.rejects(service.trace(from(sessionId), sessionId, signal), /no tau session/u)
})

test('a run whose agent did not leave what its tau declares fails, and gives back nothing', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  delete boxes.left['/tau/out/report.md']
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId } = await startIn(service, HOST, tauDir, call, work)
  sessions.end(sessionId, completed('Done.'))
  const result = await finish(service, HOST, sessionId)
  assert.equal(result.ok, false)
  assert.equal(result.text, 'Done.')
  assert.match(result.failure ?? '', /^the run did not leave what the call asks:\n {2}report: \S+\/tau\/out\/report\.md does not exist$/u)
  assert.deepEqual(await readdir(join(work, 'out')), [])
  assert.deepEqual(await readdir(join(work, 'site')), ['index.md'])
})

test('a result its box packs that does not fit the run fails the run, since the box is the agent\'s', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  const run = async (): Promise<Result> => {
    const { sessionId } = await startIn(service, HOST, tauDir, call, work)
    sessions.end(sessionId, completed('Done.'))
    return await finish(service, HOST, sessionId)
  }
  boxes.tamper = () => packResult({ ok: true, text: 'Done.', outputs: {} }, {})
  assert.deepEqual(await run(), {
    ok: false,
    text: 'Done.',
    failure: 'could not get back what the run gave: the report does not fit the run:\n  site: the run succeeded, but gave nothing back for it\n  report: the run succeeded, but gave nothing back for it\n  pages: the run succeeded, but gave nothing back for it',
  })
  boxes.tamper = () => packResult({ ok: true, text: 'Something else.', outputs: {} }, {})
  assert.equal((await run()).failure, 'could not get back what the run gave: its text is not the agent\'s')
  boxes.tamper = () => once(Buffer.from('not an archive'))
  assert.match((await run()).failure ?? '', /^could not get back what the run gave: the result breaks the spec: /u)
  assert.deepEqual(await readdir(join(work, 'out')), [])
})

test('what a run that failed left is not packed, nor given back', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId } = await startIn(service, HOST, tauDir, call, work)
  sessions.end(sessionId, { ok: false, text: '', failure: 'the run was cancelled' })
  assert.equal((await finish(service, HOST, sessionId)).ok, false)
  assert.deepEqual(boxes.calls.filter(call => call === 'pipe pack'), [])
  assert.deepEqual(await readdir(join(work, 'out')), [])
})

test('a run ends with why it failed, and is ended, not finished, until a finish gives that back', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const service = make(work, () => {}, sessions, new FakeBoxes(work))
  const { sessionId } = await startIn(service, HOST, tauDir, call, work)
  sessions.end(sessionId, { ok: false, text: 'Half', failure: 'the run failed: rate limited' })
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

test('a running run has no result yet, and giving up waiting for it leaves it running', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const service = make(work, () => {}, sessions, new FakeBoxes(work))
  const { sessionId } = await startIn(service, HOST, tauDir, call, work)
  await assert.rejects(service.result(HOST, sessionId), new RegExp(`^Error: fleet: ${sessionId} has no result yet: it is running$`, 'u'))
  const waiting = new AbortController()
  const ending = service.untilEnded(HOST, sessionId, waiting.signal)
  waiting.abort(new Error('gone'))
  await assert.rejects(ending, /gone/u)
  assert.deepEqual(await service.status(HOST, sessionId), { state: 'running' })
  sessions.end(sessionId, completed('Done.'))
  assert.deepEqual(await finish(service, HOST, sessionId), { ok: true, text: 'Done.' })
})

test('a start that fails on the way archives the session, and removes its box and its entry', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  sessions.failing = 'prompt'
  await assert.rejects(startIn(service, HOST, tauDir, call, work), /prompt failed/u)
  assert.deepEqual(sessions.calls.map(call => call.split(' ')[0]), ['create', 'prompt', 'archive'])
  assert.equal(boxes.calls.at(-1), 'remove')
  assert.deepEqual(await service.list(HOST), [])
})

/** Give the fixture's tau an init, `node ${self}/init.mts`. */
async function withInit(tauDir: string): Promise<void> {
  const json = JSON.parse(await readFile(join(tauDir, 'tau.json'), 'utf8')) as object
  await writeFile(join(tauDir, 'tau.json'), JSON.stringify({ ...json, init: 'node ${self}/init.mts' }))
}

/** The calls a box's helper got to spawn processes, each its argv and its folder. */
function spawned(boxes: FakeBoxes): unknown[] {
  return boxes.calls.filter(call => call.startsWith('spawn ')).map((call) => {
    const { argv, cwd } = JSON.parse(call.slice('spawn '.length)) as { argv: string[]; cwd: string }
    return { argv, cwd }
  })
}

test('a tau\'s init runs in the agent\'s working directory before the agent, its ${self} expanded, and exiting 0 does the run without it, its stdout the final text', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  await withInit(tauDir)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  boxes.spawn = async (_params, write) => {
    write('stdout', 'Did it ')
    write('stdout', 'all.\n')
    write('stderr', 'noise\n')
    return { code: 0, signal: null }
  }
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId } = await startIn(service, HOST, tauDir, call, work)
  const { project } = await new Registry(join(work, 'taus')).get(sessionId)
  assert.deepEqual(await finish(service, HOST, sessionId), { ok: true, text: 'Did it all.\n' })
  assert.deepEqual(spawned(boxes), [{ argv: ['sh', '-c', 'node /tau/self/init.mts'], cwd: '/tau/workspace' }])
  // The session is made, and never prompted.
  assert.deepEqual(sessions.calls, [`create ${sessionId} ${project} tau`])
  assert.equal(boxes.calls.at(-1), 'stop')
  assert.equal(await readFile(join(work, 'out', 'report.md'), 'utf8'), 'Added milk.\n')

  // Without what the tau declares at its files, the run fails, as an agent's does.
  boxes.left = {}
  const { sessionId: bare } = await startIn(service, HOST, tauDir, call, work)
  const failed = await finish(service, HOST, bare)
  assert.equal(failed.ok, false)
  assert.match(String(failed.failure), /did not leave what the call asks/u)
})

test('a tau\'s init exiting 100 has the agent run on the prompt as it is, and any other ending tells the agent it failed', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  await withInit(tauDir)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  const prompted = async (end: { code: number | null; signal: string | null }, stdout: string, stderr: string): Promise<string> => {
    sessions.calls.length = 0
    boxes.spawn = async (_params, write) => {
      if (stdout !== '') write('stdout', stdout)
      if (stderr !== '') write('stderr', stderr)
      return end
    }
    const { sessionId } = await startIn(service, HOST, tauDir, call, work)
    const { promptRequestId } = await new Registry(join(work, 'taus')).get(sessionId)
    const finishing = finish(service, HOST, sessionId)
    while (sessions.calls.length < 2) await new Promise(resolve => setImmediate(resolve))
    sessions.end(sessionId, completed('Done.'))
    assert.deepEqual(await finishing, { ok: true, text: 'Done.' })
    const prompt = sessions.calls[1] ?? ''
    assert.ok(prompt.startsWith(`prompt ${sessionId} ${promptRequestId} `), prompt)
    return prompt.slice(`prompt ${sessionId} ${promptRequestId} `.length)
  }
  assert.equal(await prompted({ code: 100, signal: null }, 'ignored\n', ''), EXPANDED)
  assert.equal(await prompted({ code: 101, signal: null }, 'Looked up 2 notes.\n', 'no ```site``` found'), [
    EXPANDED.trimEnd(),
    '',
    '---',
    '',
    'This TAU\'s init, `node /tau/self/init.mts`, ran before you, and failed: it exited with 101. Do the task yourself, without it; what it left at your files\' places is still there.',
    '',
    'Its stdout:',
    '',
    '```',
    'Looked up 2 notes.',
    '```',
    '',
    'Its stderr:',
    '',
    '````',
    'no ```site``` found',
    '````',
    '',
  ].join('\n'))
  assert.match(await prompted({ code: 1, signal: null }, '', 'Error: boom\n'), /failed: it exited with 1\. .*\n\nIts stdout: nothing\.\n\nIts stderr:\n\n```\nError: boom\n```\n$/u)
  assert.match(await prompted({ code: null, signal: 'SIGKILL' }, '', ''), /failed: it was killed by SIGKILL\./u)
})

test('releasing a run while its init runs ends the init, and the run, without its agent', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  await withInit(tauDir)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const killed = Promise.withResolvers<{ code: number | null; signal: string | null }>()
  boxes.spawn = () => killed.promise
  boxes.kill = () => { killed.resolve({ code: null, signal: 'SIGTERM' }) }
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId } = await startIn(service, HOST, tauDir, call, work)
  while (spawned(boxes).length === 0) await new Promise(resolve => setImmediate(resolve))
  await service.release(HOST, sessionId)
  assert.equal(boxes.calls.filter(call => call.startsWith('kill ')).length, 1)
  assert.deepEqual(sessions.calls.map(call => call.split(' ')[0]), ['create', 'archive'])
  await assert.rejects(service.status(HOST, sessionId), /no tau session/u)
  await service.close()
})

test('a host that stops while a run\'s init runs leaves the run to fail, unprompted, once a service started later watches it', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  await withInit(tauDir)
  const boxes = new FakeBoxes(work)
  const killed = Promise.withResolvers<{ code: number | null; signal: string | null }>()
  boxes.spawn = () => killed.promise
  boxes.kill = () => { killed.resolve({ code: null, signal: 'SIGTERM' }) }
  const sessions = new FakeSessions()
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId } = await startIn(service, HOST, tauDir, call, work)
  while (spawned(boxes).length === 0) await new Promise(resolve => setImmediate(resolve))
  await service.close()
  assert.equal(sessions.calls.length, 1)
  const later = make(work, () => {}, new FakeSessions(), new FakeBoxes(work))
  // As fleet-tau-runs loads them, before the service.
  await later.tauRuns.load()
  await later.load()
  assert.deepEqual(await finish(later, HOST, sessionId), { ok: false, text: '', failure: 'the fleet host stopped before the run got its prompt' })
})

test('a service started later watches the runs that had not ended, and fails one that never got its prompt', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions(), new FakeBoxes(work))
  const { sessionId: running } = await startIn(service, HOST, tauDir, call, work)
  // As a host that stopped between setting up the box and prompting the session leaves it.
  const { sessionId: unprompted } = await create(service, tauDir, call, work)
  await service.close()

  // dsh closes a turn a stop cut short as interrupted.
  const sessions = new FakeSessions()
  sessions.end(running, { ok: false, text: '', failure: 'the fleet host stopped during the run' })
  const later = make(work, () => {}, sessions, new FakeBoxes(work))
  // As fleet-tau-runs loads them, before the service.
  await later.tauRuns.load()
  await later.load()
  assert.deepEqual(await finish(later, HOST, running), { ok: false, text: '', failure: 'the fleet host stopped during the run' })
  assert.deepEqual(await finish(later, HOST, unprompted), { ok: false, text: '', failure: 'the fleet host stopped before the run got its prompt' })
  assert.deepEqual((await later.list(HOST)).map(status => status.sessionId), [running, unprompted])
})

test('releasing archives the session before it removes the box, and a failed archive keeps both', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId, box } = await startIn(service, HOST, tauDir, call, work)
  sessions.calls.length = 0

  sessions.failing = 'archive'
  await assert.rejects(service.release(HOST, sessionId), /archive failed/u)
  assert.ok(boxes.existing.has(box))
  await new Registry(join(work, 'taus')).get(sessionId)

  await service.release(HOST, sessionId)
  assert.ok(!boxes.existing.has(box))
  assert.deepEqual(sessions.calls, [`archive ${sessionId}`, `archive ${sessionId}`])
  // Its agent stops with the archive; nothing is recorded of a run that is gone.
  sessions.end(sessionId, completed('Done.'))
  await assert.rejects(service.result(HOST, sessionId), /no tau session/u)
  await service.close()
  assert.deepEqual(await readdir(join(work, 'taus')), [])
})

/** A tau's session as the caller of the runs it starts from its box. */
function from(sessionId: string): Caller {
  return { kind: 'session', sessionId }
}

test('a tau\'s session submits a run from its box as the host does, in its own project, and another session in the project it names', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions(), new FakeBoxes(work))
  const { sessionId: parent } = await startIn(service, HOST, tauDir, call, work)
  const elsewhere = await mkdtemp(join(tmpdir(), 'fleet-tau-elsewhere-'))
  t.after(() => rm(elsewhere, { recursive: true, force: true }))
  // What a session names as its project is not its runs'.
  const { about, archive } = callOf(tauDir, call, work)
  const { sessionId: child, prompt } = await service.submit(from(parent), { ...about, project: elsewhere }, archive)
  assert.equal(prompt, EXPANDED)
  const entry = await new Registry(join(work, 'taus')).get(child)
  assert.deepEqual(entry.caller, from(parent))
  assert.equal(entry.project, await realpath(work))
  assert.equal((await listed(service, child)).parent, parent)
  // A session that is no tau's, as with tau_run, names its project, as the host does.
  const other = 'session-00000000-0000-4000-8000-000000000000'
  const { sessionId: own } = await startIn(service, from(other), tauDir, call, work)
  assert.equal((await new Registry(join(work, 'taus')).get(own)).project, await realpath(work))
  assert.equal((await listed(service, own)).parent, other)
  await assert.rejects(service.submit(from(other), { title: 'tau' }, callOf(tauDir, call, work).archive), /names its project, an absolute path/u)
})

test('a tau\'s session reaches only the runs it started, and the host every run', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions(), new FakeBoxes(work))
  const { sessionId: parent } = await startIn(service, HOST, tauDir, call, work)
  const { sessionId: other } = await startIn(service, HOST, tauDir, call, work)
  const { sessionId: child } = await startIn(service, from(parent), tauDir, call, work)
  assert.deepEqual((await service.list(from(parent))).map(status => status.sessionId), [child])
  assert.deepEqual(await service.list(from(other)), [])
  assert.deepEqual((await service.list(HOST)).map(status => status.sessionId), [parent, other, child])
  const signal = new AbortController().signal
  const reaches = [
    () => service.status(from(other), child), () => service.result(from(other), child), () => service.trace(from(other), child, signal),
    () => service.untilEnded(from(other), child, signal),
    () => service.release(from(other), child), () => service.status(from(child), parent),
  ]
  for (const reach of reaches) await assert.rejects(reach, new RegExp(`no tau session (${child}|${parent})`, 'u'))
  assert.equal((await service.status(from(parent), child)).state, 'running')
})

test('a run\'s end releases the runs it started and did not finish, and its release every run it started', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId: parent } = await startIn(service, HOST, tauDir, call, work)
  const { sessionId: finished } = await startIn(service, from(parent), tauDir, call, work)
  const { sessionId: running } = await startIn(service, from(parent), tauDir, call, work)
  const { sessionId: grandchild } = await startIn(service, from(running), tauDir, call, work)
  sessions.end(finished, completed('Done.'))
  await finish(service, from(parent), finished)
  sessions.calls.length = 0

  sessions.end(parent, completed('Done.'))
  await finish(service, HOST, parent)
  while ((await service.list(HOST)).length > 2) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual((await service.list(HOST)).map(status => status.sessionId), [parent, finished])
  assert.deepEqual(sessions.calls.sort(), [`archive ${grandchild}`, `archive ${running}`].sort())

  await service.release(HOST, parent)
  assert.deepEqual(await service.list(HOST), [])
})

test('a tau session\'s box is started for its files and processes once, and again after a stop', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, new FakeSessions(), boxes)
  const { sessionId, box } = await create(service, tauDir, call, work)
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
  await later.release(HOST, sessionId)
  assert.equal(later.tauRuns.isTau(sessionId), false)
  assert.equal(await later.tauRuns.boxFor(sessionId), undefined)
})

test('archiving a run\'s session removes its box once the run ended, keeping the run, and unarchiving has it set up again from the call', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId, box } = await startIn(service, HOST, tauDir, call, work)
  const archiving = service.followArchive(new Set([sessionId]))
  // Its box packs the run's result as the run ends, so it stays until then.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(await boxes.exists(box), true)
  sessions.end(sessionId, completed('Done.'))
  await archiving
  assert.equal(await boxes.exists(box), false)
  await assert.rejects(service.tauRuns.boxFor(sessionId), /is archived/u)
  // The run is kept: its caller finishes it as before.
  assert.deepEqual(await finish(service, HOST, sessionId), { ok: true, text: 'Done.' })
  assert.equal(await readFile(join(work, 'out', 'report.md'), 'utf8'), 'Added milk.\n')
  assert.equal((await new Registry(join(work, 'taus')).get(sessionId)).resetAt, undefined)

  await service.followArchive(new Set())
  boxes.calls.length = 0
  assert.equal((await service.tauRuns.boxFor(sessionId))?.container, box)
  assert.deepEqual(boxes.calls.map(call => call.split(' ')[0]), ['create', 'start', 'pipe', 'copyIn', 'copyIn', 'apis.link'])
  // As the run began: what the agent left is gone.
  assert.equal(await readFile(join(boxes.root(box), 'tau', 'in', 'notes.md'), 'utf8'), 'buy milk\n')
  assert.deepEqual(await readdir(join(boxes.root(box), 'tau', 'workspace', 'site')), ['index.md'])
  assert.notEqual((await new Registry(join(work, 'taus')).get(sessionId)).resetAt, undefined)
  boxes.calls.length = 0
  await service.tauRuns.boxFor(sessionId)
  assert.deepEqual(boxes.calls, [])

  // And so with a box removed by other means.
  const { resetAt } = await new Registry(join(work, 'taus')).get(sessionId)
  await service.tauRuns.stop(sessionId)
  boxes.existing.delete(box)
  await rm(boxes.root(box), { recursive: true, force: true })
  boxes.calls.length = 0
  await service.tauRuns.boxFor(sessionId)
  assert.equal(boxes.calls[0], `create ${box}`)
  assert.notEqual((await new Registry(join(work, 'taus')).get(sessionId)).resetAt, resetAt)
})

test('archiving a session removes the boxes of the runs it started, and of theirs, and of no other', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  // A session that is no tau's, as with tau_run, and a run it started, which started another.
  const caller = 'session-22222222-2222-4222-8222-222222222222'
  const child = await startIn(service, from(caller), tauDir, call, work)
  const grandchild = await startIn(service, from(child.sessionId), tauDir, call, work)
  const other = await startIn(service, HOST, tauDir, call, work)
  // Finished, or the end of the run that started it would delete it.
  sessions.end(grandchild.sessionId, completed('Done.'))
  await finish(service, from(child.sessionId), grandchild.sessionId)
  for (const { sessionId } of [child, other]) sessions.end(sessionId, completed('Done.'))
  await service.followArchive(new Set([caller]))
  assert.deepEqual(await Promise.all([child, grandchild, other].map(({ box }) => boxes.exists(box))), [false, false, true])
  assert.deepEqual((await service.list(HOST)).map(status => status.sessionId), [child, grandchild, other].map(({ sessionId }) => sessionId))
  await service.followArchive(new Set())
  assert.equal((await service.tauRuns.boxFor(grandchild.sessionId))?.container, grandchild.box)
})

test('a run\'s end stops its box at once, unless something occupies it, and then as soon as nothing does', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeBoxes(work)
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId } = await startIn(service, HOST, tauDir, call, work)
  const terminal = await service.tauRuns.hold(sessionId, { kind: 'terminal', id: 'shell' })
  sessions.end(sessionId, completed('Done.'))
  while ((await service.status(HOST, sessionId)).state === 'running') await new Promise(resolve => setImmediate(resolve))
  assert.notEqual(boxes.calls.at(-1), 'stop')
  // Not after the minute a box is idle by default, but at once.
  terminal?.release()
  await delay(20)
  assert.equal(boxes.calls.at(-1), 'stop')
})

test('deleting a session whose box is gone forgets the session', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const boxes = new FakeBoxes(work)
  const { sessionId, box } = await create(make(work, () => {}, new FakeSessions(), boxes), tauDir, call, work)
  boxes.existing.delete(box)
  // As after a restart.
  const service = make(work, () => {}, new FakeSessions(), boxes)
  await service.tauRuns.load()
  await assert.rejects(service.tauRuns.start(sessionId), /No such container/u)
  await service.release(HOST, sessionId)
  await assert.rejects(service.status(HOST, sessionId), /no tau session/u)
})

test('a tau session\'s project, where dsh runs its work, is /tau/workspace in its box', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions(), new FakeBoxes(work))
  const { sessionId } = await create(service, tauDir, call, work)
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

test('a real box places a call\'s files and the tau, and packs what its agent left', { skip: await absent(DEFAULT_IMAGE) }, async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions())
  const { sessionId, box, prompt } = await create(service, tauDir, call, work)
  try {
    assert.equal(prompt, EXPANDED)
    await service.tauRuns.start(sessionId)
    const { stdout } = await run('docker', ['exec', box, 'find', '/tau', '-path', '/tau/node_modules', '-prune', '-o', '-not', '-type', 'd', '-print'])
    assert.deepEqual(stdout.trim().split('\n').sort(), [
      '/tau/.run.json', '/tau/TAU.md', '/tau/TAU_DEV.md', '/tau/in/notes.md', '/tau/self/PROMPT.md', '/tau/self/tau.json',
      '/tau/workspace/site/index.md',
    ])
    // A program below /tau imports the API, and its client's call reaches the extension's server, as this session's.
    added.length = 0
    const started = await service.tauRuns.boxFor(sessionId)
    const program = 'import { add } from "@test/notes"; process.stdout.write(await add("milk"));'
    const ran = await started?.request('exec', { argv: ['sh', '-c', `cd /tau/workspace && node --input-type=module --eval '${program}'`] })
    assert.deepEqual(ran, { code: 0, signal: null, stdout: 'added milk', stderr: '' })
    assert.deepEqual(added, [{ args: ['milk'], sessionId }])
    // A TypeScript program the model runs from the tau's directory, as its prompt says, which node runs as is, imports a
    // package of the tau's own, which nothing links, built on the API.
    await started?.request('exec', { argv: ['sh', '-c', [
      'mkdir -p /tau/self/node_modules/twice',
      `echo '{"name":"twice","type":"module","exports":"./index.js"}' > /tau/self/node_modules/twice/package.json`,
      `echo 'import { add } from "@test/notes"; export const twice = async text => [await add(text), await add(text)]' > /tau/self/node_modules/twice/index.js`,
    ].join(' && ')] })
    const typed = await started?.request('exec', { argv: ['sh', '-c', [
      "cd /tau/self; node - eggs <<'EOF'",
      'import { twice } from "twice"',
      'const said: string[] = await twice(process.argv[2] ?? "")',
      'process.stdout.write(said.join(", "))',
      'EOF',
    ].join('\n')] })
    assert.deepEqual(typed, { code: 0, signal: null, stdout: 'added eggs, added eggs', stderr: '' })
    assert.deepEqual(added.at(-1), { args: ['eggs'], sessionId })
    assert.equal((await run('docker', ['exec', box, 'cat', '/tau/in/notes.md'])).stdout, 'buy milk\n')
    await run('docker', ['exec', box, 'test', '-d', '/tau/out/pages'])
    // The caller's folder, where dsh runs the session's work, is /tau/workspace in the box, and not there at its own path.
    await assert.rejects(run('docker', ['exec', box, 'test', '-e', await realpath(work)]))

    // A link that leads out of its file fails the run, in the box.
    const exec = async (script: string): Promise<void> => { assert.equal((await started?.request('exec', { argv: ['sh', '-c', script] }))?.code, 0) }
    await exec('echo Added. > /tau/out/report.md && echo A > /tau/out/pages/a.md && ln -s /etc/passwd /tau/out/pages/leak')
    const leaked = await service.tauRuns.pack(sessionId, { ok: true, text: 'Done.' })
    assert.match(leaked.failure ?? '', /^the run did not leave what the call asks:\n {2}pages: \/tau\/out\/pages\/leak: leads to the absolute path \/etc\/passwd/u)
    // What the agent leaves is packed in the box, read and checked here, and put at the caller's paths by the caller.
    await exec('rm /tau/out/pages/leak && ln -s a.md /tau/out/pages/latest && echo more >> /tau/workspace/site/index.md')
    assert.deepEqual(await service.tauRuns.pack(sessionId, { ok: true, text: 'Done.' }), { ok: true, text: 'Done.' })
    assert.deepEqual(await deliver(sessionId, await service.tauRuns.result(sessionId)), { ok: true, text: 'Done.' })
    assert.equal(await readFile(join(work, 'out', 'report.md'), 'utf8'), 'Added.\n')
    assert.equal(await readlink(join(work, 'out', 'pages', 'latest')), 'a.md')
    assert.equal(await readFile(join(work, 'site', 'index.md'), 'utf8'), '# Home\nmore\n')
    assert.equal(await readFile(join(work, 'notes.md'), 'utf8'), 'buy milk\n')
    await service.tauRuns.stop(sessionId)
  } finally {
    await service.release(HOST, sessionId)
  }
  await assert.rejects(run('docker', ['container', 'inspect', box]), /No such container/u)
})

test('a real box runs a tau\'s init in the agent\'s working directory, and a program of the tau\'s it names with ${self} imports what the agent\'s programs do', { skip: await absent(DEFAULT_IMAGE) }, async (t) => {
  const { work, tauDir, call } = await fixture(t)
  await withInit(tauDir)
  await writeFile(join(tauDir, 'init.mts'), [
    'import { mkdirSync, writeFileSync } from "node:fs"',
    'import { add } from "@test/notes"',
    'const said: string = await add("milk")',
    'writeFileSync("/tau/out/report.md", `${said}\\n`)',
    'mkdirSync("/tau/out/pages", { recursive: true })',
    'console.log(`${said} in ${process.cwd()}`)',
  ].join('\n'))
  const sessions = new FakeSessions()
  const service = make(work, () => {}, sessions)
  added.length = 0
  const { sessionId, box } = await startIn(service, HOST, tauDir, call, work)
  try {
    assert.deepEqual(await finish(service, HOST, sessionId), { ok: true, text: 'added milk in /tau/workspace\n' })
    assert.deepEqual(added, [{ args: ['milk'], sessionId }])
    assert.equal(await readFile(join(work, 'out', 'report.md'), 'utf8'), 'added milk\n')
    assert.equal(sessions.calls.length, 1)
  } finally {
    await service.release(HOST, sessionId)
  }
  await assert.rejects(run('docker', ['container', 'inspect', box]), /No such container/u)
})
