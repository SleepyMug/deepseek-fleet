import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { type CallFile, checkInputs, type Delivery, type Envelope, kindAt, loadTau, type Report } from '@sleepymug/tau/core'
import { readContents } from '@sleepymug/tau/transfer'
import { encodeCall, packCall, packResult, unpackResult } from '@sleepymug/tau/wire-tar'
import type { BoxSpec, BoxState } from '@sleepymug/fleet-protocol/fleet'
import type { Result, RunStatus } from '@sleepymug/dsh-tau-box/runs'
import { pack, setup } from '@sleepymug/dsh-tau-box/box/endpoint'
import { readTauCommand } from '@sleepymug/dsh-tau-box/protocol'
import { systemPlatform } from '../platform.ts'
import { abortable } from '../util/abort.ts'
import type { FleetBoxPort, FleetPort, Started } from './ports.ts'
import { HOST, Registry, type Caller } from './registry.ts'
import { BOX_ENV, TauRuns } from './runs.ts'
import { FakeFleet } from './fake-fleet.test.util.ts'
import { tauService } from './box-service.ts'
import { fleetOf } from './fleet.ts'
import { FleetClient } from '@sleepymug/fleet-client'
import { FleetHost, Registry as FleetRegistry, systemPlatform as fleetPlatform } from '@sleepymug/fleet/host'
import { listen } from '@sleepymug/fleet/server'
import { TauService, TRACE_FORMAT, type Sessions } from './service.ts'

const run = promisify(execFile)

const PROMPT = 'Add ${notes} to ${site} in a ${style} style, then write ${report} and fill ${pages}. You are ${self}.\n'
const EXPANDED = 'Add /tau/in/notes.md to /tau/workspace/site in a terse style, then write /tau/out/report.md and fill /tau/out/pages. You are /tau/self.\n'

/** A folder with a tau that takes a file of each mode, and exposes a package of its own, and the caller's files for it. */
async function fixture(t: { after(fn: () => Promise<void>): void }): Promise<{ work: string; tauDir: string; call: { files: Record<string, string>; args: Record<string, unknown> } }> {
  const work = await mkdtemp(join(tmpdir(), 'dsh-tau-test-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const tauDir = join(work, 'tau')
  await mkdir(join(tauDir, 'node_modules', 'kit'), { recursive: true })
  await writeFile(join(tauDir, 'PROMPT.md'), PROMPT)
  await writeFile(join(tauDir, 'tau.json'), JSON.stringify({
    files: {
      notes: { kind: 'file', mode: 'in', description: 'What to add.' },
      site: { kind: 'dir', mode: 'inout', description: 'The pages.' },
      report: { kind: 'file', mode: 'out', description: 'What changed.' },
      pages: { kind: 'dir', mode: 'out', description: 'New pages.' },
    },
    args: { type: 'object', properties: { style: { type: 'string', description: 'How to write.' } }, required: ['style'] },
    exposes: ['kit'],
  }))
  // A package of the tau's own, which its programs import by its name, below the program directory.
  await writeFile(join(tauDir, 'node_modules', 'kit', 'package.json'), JSON.stringify({ name: 'kit', type: 'module', exports: './index.js', description: 'Twice as much.' }))
  await writeFile(join(tauDir, 'node_modules', 'kit', 'index.js'), 'export const twice = text => `${text}, ${text}`\n')
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

/** The tau backend on runs in `work`, with the runs at hand, its boxes the fake fleet host's, or `fleet`. */
function make(work: string, log: (message: string) => void, sessions: Sessions, fleet: FleetPort = new FakeFleet(work, LEFT)): TauService & { tauRuns: TauRuns } {
  const platform = systemPlatform(log)
  const runs = new TauRuns({ registry: new Registry(join(work, 'taus')), fleet, platform })
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

/** Put a run's result at its caller's paths, as tau's socket adaptor does, and give back how it ended. */
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

test('setting up a run\'s box makes it on the fleet host, has the box\'s half place the files, and registers the session', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const fleet = new FakeFleet(work, LEFT)
  const logged: string[] = []
  const service = make(work, (message) => { logged.push(message) }, new FakeSessions(), fleet)

  const created = await create(service, tauDir, call, work)
  const project = await realpath(work)
  assert.match(created.sessionId, /^session-[0-9a-f-]{36}$/u)
  assert.match(created.box, /^box-[0-9a-f]{16}$/u)
  assert.equal(created.prompt, EXPANDED)
  assert.deepEqual(fleet.calls, [`create ${created.box}`, 'start', 'pipe setup'])
  // Made for the session, with its run's context, the tau's packages' commands on its PATH.
  assert.deepEqual(fleet.made.get(created.box)?.spec, { labels: { 'dsh.session': created.sessionId, 'tau.title': 'tau' }, env: BOX_ENV })
  assert.deepEqual(BOX_ENV, { TAU_CONTEXT: '/tau/context.json' })
  // The box's half placed everything where it has things.
  const root = fleet.root(created.box)
  assert.equal(await readFile(join(root, 'tau/in/notes.md'), 'utf8'), 'buy milk\n')
  assert.equal(await readFile(join(root, 'tau/workspace/site/index.md'), 'utf8'), '# Home\n')
  assert.equal(await readFile(join(root, 'tau/self/PROMPT.md'), 'utf8'), PROMPT)
  assert.deepEqual(await readdir(join(root, 'tau/out')), ['pages'])
  assert.equal(await readlink(join(root, 'tau/node_modules')), 'self/node_modules')
  // The call is kept; the tau read from it here is gone.
  assert.deepEqual(await readdir(join(work, 'taus', created.sessionId)), ['call.tar'])

  const entry = await new Registry(join(work, 'taus')).get(created.sessionId)
  assert.equal(entry.box, created.box)
  assert.equal(entry.title, 'tau')
  assert.equal(entry.project, project)
  assert.equal(entry.prompt, EXPANDED)
  assert.match(entry.promptRequestId, /^[0-9a-f-]{36}$/u)
  assert.equal(entry.promptedAt, undefined)
  assert.deepEqual(entry.exposed, [{ specifier: 'kit', dir: '/tau/node_modules/kit', description: 'Twice as much.' }])
  assert.deepEqual(entry.skills, [])
  assert.deepEqual(entry.files, {
    notes: { mode: 'in', kind: 'file', base: 'notes.md', description: 'What to add.', place: '/tau/in/notes.md' },
    site: { mode: 'inout', kind: 'dir', base: 'site', description: 'The pages.', place: '/tau/workspace/site' },
    report: { mode: 'out', kind: 'file', base: 'report.md', description: 'What changed.', place: '/tau/out/report.md' },
    pages: { mode: 'out', kind: 'dir', base: 'pages', description: 'New pages.', place: '/tau/out/pages' },
  })
  assert.equal(entry.cwd, '/tau/workspace')
  assert.equal(entry.programs, '/tau')
  assert.equal(service.tauRuns.sessionOfBox(created.box), created.sessionId)
  assert.equal(service.tauRuns.sessionOfBox('box-ffffffffffffffff'), undefined)
  assert.match(logged.join('\n'), new RegExp(`created ${created.sessionId} in ${created.box}`, 'u'))
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
  const boxes = new FakeFleet(work, LEFT)
  const service = make(work, () => {}, new FakeSessions(), boxes)
  const about = { title: 'tau', project: work }
  const whole = await bytesOf(callOf(tauDir, call, work).archive)
  await assert.rejects(service.submit(HOST, about, once(whole.subarray(0, 1024))), /^Error: the call breaks the spec: /u)
  const unfit = encodeCall({ files: {}, args: { style: 'terse' } }, readContents([{ from: tauDir }]))
  await assert.rejects(service.submit(HOST, about, unfit), /^Error: dsh-tau: the call does not fit the tau:\n {2}no path for notes, site, report, pages$/u)
  // A tau's problems name it by the run's title.
  await mkdir(join(work, 'empty'))
  const empty = encodeCall({ files: {}, args: {} }, readContents([{ from: join(work, 'empty') }]))
  await assert.rejects(service.submit(HOST, { ...about, title: 'mine' }, empty), /^Error: dsh-tau: the tau mine: not a tau \(no PROMPT\.md\)$/u)
  // A tau whose links lead out of it is no content of a call.
  await symlink('/etc/passwd', join(tauDir, 'leak.md'))
  await assert.rejects(service.submit(HOST, about, encodeCall({ files: {}, args: {} }, readContents([{ from: tauDir }]))),
    /the call breaks the spec: tau\/leak\.md: leads to the absolute path \/etc\/passwd/u)
  await assert.rejects(service.submit(HOST, { ...about, project: 'here' }, once(whole)), /names its project, an absolute path/u)
  assert.deepEqual(boxes.calls, [])
  assert.deepEqual(await readdir(join(work, 'taus')), [])
})

test('a set-up that fails removes its box and registers nothing', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const boxes = new FakeFleet(work, LEFT)
  boxes.failing = 'pipe'
  const service = make(work, () => {}, new FakeSessions(), boxes)
  await assert.rejects(startIn(service, HOST, tauDir, call, work), /pipe failed/u)
  assert.equal(boxes.calls.at(-1), 'remove')
  assert.equal(boxes.made.size, 0)
  assert.deepEqual(await readdir(join(work, 'taus')), [])
})

test('a run starts its box, makes the dsh session in the caller\'s folder with the prompt, and ends once its agent is done', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeFleet(work, LEFT)
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId } = await startIn(service, HOST, tauDir, call, work)
  const { promptRequestId, project } = await new Registry(join(work, 'taus')).get(sessionId)
  assert.deepEqual(boxes.calls, [`create ${(await new Registry(join(work, 'taus')).get(sessionId)).box}`, 'start', 'pipe setup'])
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
  const boxes = new FakeFleet(work, LEFT)
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
  const service = make(work, () => {}, sessions, new FakeFleet(work, LEFT))
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
  const boxes = new FakeFleet(work, LEFT)
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
  const boxes = new FakeFleet(work, LEFT)
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
  const boxes = new FakeFleet(work, LEFT)
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
  const service = make(work, () => {}, sessions, new FakeFleet(work, LEFT))
  const { sessionId } = await startIn(service, HOST, tauDir, call, work)
  sessions.end(sessionId, { ok: false, text: 'Half', failure: 'the run failed: rate limited' })
  await service.close()
  const later = make(work, () => {}, sessions, new FakeFleet(work, LEFT))
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
  const service = make(work, () => {}, sessions, new FakeFleet(work, LEFT))
  const { sessionId } = await startIn(service, HOST, tauDir, call, work)
  await assert.rejects(service.result(HOST, sessionId), new RegExp(`^Error: dsh-tau: ${sessionId} has no result yet: it is running$`, 'u'))
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
  const boxes = new FakeFleet(work, LEFT)
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
function spawned(boxes: FakeFleet): unknown[] {
  return boxes.calls.filter(call => call.startsWith('spawn ')).map((call) => {
    const { argv, cwd } = JSON.parse(call.slice('spawn '.length)) as { argv: string[]; cwd: string }
    return { argv, cwd }
  })
}

test('a tau\'s init runs in the agent\'s working directory before the agent, its ${self} expanded, and exiting 0 does the run without it, its stdout the final text', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  await withInit(tauDir)
  const sessions = new FakeSessions()
  const boxes = new FakeFleet(work, LEFT)
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
  const boxes = new FakeFleet(work, LEFT)
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
  const boxes = new FakeFleet(work, LEFT)
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
  const boxes = new FakeFleet(work, LEFT)
  const killed = Promise.withResolvers<{ code: number | null; signal: string | null }>()
  boxes.spawn = () => killed.promise
  boxes.kill = () => { killed.resolve({ code: null, signal: 'SIGTERM' }) }
  const sessions = new FakeSessions()
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId } = await startIn(service, HOST, tauDir, call, work)
  while (spawned(boxes).length === 0) await new Promise(resolve => setImmediate(resolve))
  await service.close()
  assert.equal(sessions.calls.length, 1)
  const later = make(work, () => {}, new FakeSessions(), new FakeFleet(work, LEFT))
  // As fleet-tau-runs loads them, before the service.
  await later.tauRuns.load()
  await later.load()
  assert.deepEqual(await finish(later, HOST, sessionId), { ok: false, text: '', failure: 'dsh stopped before the run got its prompt' })
})

test('a service started later watches the runs that had not ended, and fails one that never got its prompt', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions(), new FakeFleet(work, LEFT))
  const { sessionId: running } = await startIn(service, HOST, tauDir, call, work)
  // As a host that stopped between setting up the box and prompting the session leaves it.
  const { sessionId: unprompted } = await create(service, tauDir, call, work)
  await service.close()

  // dsh closes a turn a stop cut short as interrupted.
  const sessions = new FakeSessions()
  sessions.end(running, { ok: false, text: '', failure: 'the fleet host stopped during the run' })
  const later = make(work, () => {}, sessions, new FakeFleet(work, LEFT))
  // As fleet-tau-runs loads them, before the service.
  await later.tauRuns.load()
  await later.load()
  assert.deepEqual(await finish(later, HOST, running), { ok: false, text: '', failure: 'the fleet host stopped during the run' })
  assert.deepEqual(await finish(later, HOST, unprompted), { ok: false, text: '', failure: 'dsh stopped before the run got its prompt' })
  assert.deepEqual((await later.list(HOST)).map(status => status.sessionId), [running, unprompted])
})

test('releasing archives the session before it removes the box, and a failed archive keeps both', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeFleet(work, LEFT)
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId, box } = await startIn(service, HOST, tauDir, call, work)
  sessions.calls.length = 0

  sessions.failing = 'archive'
  await assert.rejects(service.release(HOST, sessionId), /archive failed/u)
  assert.ok(boxes.made.has(box))
  await new Registry(join(work, 'taus')).get(sessionId)

  await service.release(HOST, sessionId)
  assert.ok(!boxes.made.has(box))
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
  const service = make(work, () => {}, new FakeSessions(), new FakeFleet(work, LEFT))
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
  const service = make(work, () => {}, new FakeSessions(), new FakeFleet(work, LEFT))
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
  const boxes = new FakeFleet(work, LEFT)
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
  const boxes = new FakeFleet(work, LEFT)
  const service = make(work, () => {}, new FakeSessions(), boxes)
  const { sessionId, box } = await create(service, tauDir, call, work)
  await boxes.box(box).stop()
  boxes.calls.length = 0

  assert.equal(await service.tauRuns.boxFor('session-00000000-0000-4000-8000-000000000000'), undefined)
  assert.equal(await service.tauRuns.boxFor('not-a-tau-session'), undefined)
  const [first, second] = await Promise.all([service.tauRuns.boxFor(sessionId), service.tauRuns.boxFor(sessionId)])
  assert.equal(first?.id, box)
  assert.equal(second?.id, box)
  assert.equal(service.tauRuns.isStarted(sessionId), true)
  await service.tauRuns.stop(sessionId)
  assert.equal(service.tauRuns.isStarted(sessionId), false)
  assert.equal((await service.tauRuns.boxFor(sessionId))?.id, box)
  assert.deepEqual(boxes.calls, ['start', 'stop', 'start'])
  // Closing leaves the boxes to the fleet host, which stops each once it is idle.
  service.tauRuns.close()
  assert.deepEqual(boxes.calls, ['start', 'stop', 'start'])

  // As after a restart: the registry says which sessions are a tau's, and which their boxes are.
  const later = make(work, () => {}, new FakeSessions(), boxes)
  assert.equal(later.tauRuns.isTau(sessionId), false)
  await later.tauRuns.load()
  assert.equal(later.tauRuns.isTau(sessionId), true)
  assert.equal(later.tauRuns.sessionOfBox(box), sessionId)
  await later.release(HOST, sessionId)
  assert.equal(later.tauRuns.isTau(sessionId), false)
  assert.equal(await later.tauRuns.boxFor(sessionId), undefined)
  assert.equal(boxes.made.has(box), false)
})

test('archiving a run\'s session removes its box once the run ended, keeping the run, and unarchiving has it set up again from the call', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeFleet(work, LEFT)
  const service = make(work, () => {}, sessions, boxes)
  const { sessionId, box } = await startIn(service, HOST, tauDir, call, work)
  const archiving = service.followArchive(new Set([sessionId]))
  // Its box packs the run's result as the run ends, so it stays until then.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(boxes.made.has(box), true)
  sessions.end(sessionId, completed('Done.'))
  await archiving
  assert.equal(boxes.made.has(box), false)
  await assert.rejects(service.tauRuns.boxFor(sessionId), /is archived/u)
  // The run is kept: its caller finishes it as before.
  assert.deepEqual(await finish(service, HOST, sessionId), { ok: true, text: 'Done.' })
  assert.equal(await readFile(join(work, 'out', 'report.md'), 'utf8'), 'Added milk.\n')
  assert.equal((await new Registry(join(work, 'taus')).get(sessionId)).resetAt, undefined)

  await service.followArchive(new Set())
  boxes.calls.length = 0
  const again = await service.tauRuns.boxFor(sessionId)
  assert.notEqual(again?.id, box)
  assert.equal((await new Registry(join(work, 'taus')).get(sessionId)).box, again?.id)
  assert.equal(service.tauRuns.sessionOfBox(again?.id ?? ''), sessionId)
  assert.deepEqual(boxes.calls.map(call => call.split(' ')[0]), ['create', 'start', 'pipe'])
  // As the run began: what the agent left is gone.
  const rebuilt = again?.id ?? ''
  assert.equal(await readFile(join(boxes.root(rebuilt), 'tau', 'in', 'notes.md'), 'utf8'), 'buy milk\n')
  assert.deepEqual(await readdir(join(boxes.root(rebuilt), 'tau', 'workspace', 'site')), ['index.md'])
  assert.notEqual((await new Registry(join(work, 'taus')).get(sessionId)).resetAt, undefined)
  boxes.calls.length = 0
  await service.tauRuns.boxFor(sessionId)
  assert.deepEqual(boxes.calls, [])

  // And so with a box removed by other means, which the fleet host says is gone.
  const { resetAt } = await new Registry(join(work, 'taus')).get(sessionId)
  await service.tauRuns.stop(sessionId)
  boxes.lose(rebuilt)
  boxes.calls.length = 0
  const third = await service.tauRuns.boxFor(sessionId)
  assert.equal(boxes.calls[0], `create ${String(third?.id)}`)
  assert.notEqual((await new Registry(join(work, 'taus')).get(sessionId)).resetAt, resetAt)
})

test('archiving a session removes the boxes of the runs it started, and of theirs, and of no other', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeFleet(work, LEFT)
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
  assert.deepEqual([child, grandchild, other].map(({ box }) => boxes.made.has(box)), [false, false, true])
  assert.deepEqual((await service.list(HOST)).map(status => status.sessionId), [child, grandchild, other].map(({ sessionId }) => sessionId))
  await service.followArchive(new Set())
  assert.notEqual((await service.tauRuns.boxFor(grandchild.sessionId))?.id, undefined)
})

test('a run\'s end stops its box at once, unless something occupies it, and then as soon as nothing does', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const sessions = new FakeSessions()
  const boxes = new FakeFleet(work, LEFT)
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

test('releasing a session whose box is gone forgets the session', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const boxes = new FakeFleet(work, LEFT)
  const { sessionId, box } = await create(make(work, () => {}, new FakeSessions(), boxes), tauDir, call, work)
  boxes.lose(box)
  // As after a restart.
  const service = make(work, () => {}, new FakeSessions(), boxes)
  await service.tauRuns.load()
  await service.release(HOST, sessionId)
  await assert.rejects(service.status(HOST, sessionId), /no tau session/u)
})

test('a tau session\'s project, where dsh runs its work, is /tau/workspace in its box', async (t) => {
  const { work, tauDir, call } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions(), new FakeFleet(work, LEFT))
  const { sessionId } = await create(service, tauDir, call, work)
  const project = await realpath(work)
  const { boxPath } = service.tauRuns
  assert.equal(boxPath.call(service.tauRuns, sessionId, project), '/tau/workspace')
  assert.equal(boxPath.call(service.tauRuns, sessionId, `${project}/site/index.md`), '/tau/workspace/site/index.md')
  assert.equal(boxPath.call(service.tauRuns, sessionId, `${project}-other/a`), `${project}-other/a`)
  assert.equal(boxPath.call(service.tauRuns, sessionId, '/tau/out/report.md'), '/tau/out/report.md')
  assert.equal(boxPath.call(service.tauRuns, 'not-a-tau-session', project), project)
  // As after a restart: the registry gives each session's project.
  const later = make(work, () => {}, new FakeSessions(), new FakeFleet(work, LEFT))
  await later.tauRuns.load()
  assert.equal(later.tauRuns.boxPath(sessionId, project), '/tau/workspace')
})

test('only ids of the form the service mints name sessions', async (t) => {
  const { work } = await fixture(t)
  const service = make(work, () => {}, new FakeSessions(), new FakeFleet(work, LEFT))
  for (const id of ['../../etc/passwd', 'session-1', '']) {
    await assert.rejects(service.status(HOST, id), new RegExp(`no tau session ${id.replaceAll('.', '\\.')}`, 'u'))
  }
})

/** The image the real boxes run: $FLEET_TEST_IMAGE, or the default. */
const IMAGE = process.env.FLEET_TEST_IMAGE ?? 'fleet:local'

/** Why the test needs an image that is not there, or false. */
async function absent(image: string): Promise<string | false> {
  return run('docker', ['image', 'inspect', image]).then(() => false, () => `no Docker image ${image}; build it with \`pnpm image\``)
}

/**
 * A fleet host in this process, on a socket of the test's, its boxes
 * Docker's, with the tau service registered, as dsh-tau registers it, its
 * connections served by whichever backend `served` names.
 */
async function realFleet(t: { after(fn: () => Promise<void>): void }, work: string, served: () => TauService & { tauRuns: TauRuns }): Promise<FleetPort> {
  const home = join(work, 'fleet')
  const host = new FleetHost({ registry: new FleetRegistry(join(home, 'boxes')), cache: join(home, 'services'), channels: join(home, 'channels'), platform: fleetPlatform(() => {}), image: IMAGE })
  const close = await listen(join(home, 'fleet.sock'), host)
  const client = await FleetClient.connect({ socket: join(home, 'fleet.sock') })
  await client.register(tauService(box => served().tauRuns.sessionOfBox(box), caller => served().handlerFor(caller)))
  t.after(async () => {
    await client.close()
    await close()
    await host.close()
  })
  return fleetOf(client)
}

test('a real box places a call\'s files and the tau, its packages below the program directory, and packs what its agent left', { skip: await absent(IMAGE) }, async (t) => {
  const { work, tauDir, call } = await fixture(t)
  let service: TauService & { tauRuns: TauRuns } | undefined
  const fleet = await realFleet(t, work, () => service as TauService & { tauRuns: TauRuns })
  service = make(work, () => {}, new FakeSessions(), fleet)
  const { sessionId, box, prompt } = await create(service, tauDir, call, work)
  try {
    assert.equal(prompt, EXPANDED)
    await service.tauRuns.start(sessionId)
    const started = await service.tauRuns.boxFor(sessionId)
    const exec = async (script: string): Promise<{ code: number | null; stdout: string; stderr: string }> => await started?.request('exec', { argv: ['sh', '-c', script] }) as never
    const found = await exec('find /tau -path /tau/self/node_modules -prune -o -not -type d -print')
    assert.deepEqual(found.stdout.trim().split('\n').sort(), [
      '/tau/.run.json', '/tau/TAU.md', '/tau/TAU_DEV.md', '/tau/context.json', '/tau/in/notes.md', '/tau/node_modules', '/tau/self/PROMPT.md',
      '/tau/self/tau.json', '/tau/workspace/site/index.md',
    ])
    // Its run's context, which TAU_CONTEXT names for every process.
    assert.deepEqual(JSON.parse((await exec('cat "$TAU_CONTEXT"')).stdout), { self: '/tau/self', files: { notes: '/tau/in/notes.md', site: '/tau/workspace/site', report: '/tau/out/report.md', pages: '/tau/out/pages' }, args: { style: 'terse' } })
    // A TypeScript program written below /tau, which node runs as is, imports a package of the tau's own by its name.
    const typed = await exec([
      "mkdir -p /tau/programs && cat > /tau/programs/twice.mts <<'EOF'",
      'import { twice } from "kit"',
      'const said: string = twice(process.argv[2] ?? "")',
      'process.stdout.write(said)',
      'EOF',
      'node /tau/programs/twice.mts eggs',
    ].join('\n'))
    assert.deepEqual([typed.code, typed.stdout, typed.stderr], [0, 'eggs, eggs', ''])
    // The tau service's command is there, for the agent to run taus.
    assert.match((await exec('tau --help')).stdout, /^usage: tau check/u)
    assert.equal((await exec('echo "$TAU_ADAPTOR $TAU_SOCKET"')).stdout.trim(), 'socket /run/fleet/services/tau.sock')
    assert.equal((await exec('cat /tau/in/notes.md')).stdout, 'buy milk\n')
    assert.equal((await exec('test -d /tau/out/pages')).code, 0)
    // The caller's folder, where dsh runs the session's work, is /tau/workspace in the box, and not there at its own path.
    assert.notEqual((await exec(`test -e ${await realpath(work)}`)).code, 0)

    // A link that leads out of its file fails the run, in the box.
    const ok = async (script: string): Promise<void> => { assert.equal((await exec(script)).code, 0) }
    await ok('echo Added. > /tau/out/report.md && echo A > /tau/out/pages/a.md && ln -s /etc/passwd /tau/out/pages/leak')
    const leaked = await service.tauRuns.pack(sessionId, { ok: true, text: 'Done.' })
    assert.match(leaked.failure ?? '', /^the run did not leave what the call asks:\n {2}pages: \/tau\/out\/pages\/leak: leads to the absolute path \/etc\/passwd/u)
    // What the agent leaves is packed in the box, read and checked here, and put at the caller's paths by the caller.
    await ok('rm /tau/out/pages/leak && ln -s a.md /tau/out/pages/latest && echo more >> /tau/workspace/site/index.md')
    assert.deepEqual(await service.tauRuns.pack(sessionId, { ok: true, text: 'Done.' }), { ok: true, text: 'Done.' })
    assert.deepEqual(await deliver(sessionId, await service.tauRuns.result(sessionId)), { ok: true, text: 'Done.' })
    assert.equal(await readFile(join(work, 'out', 'report.md'), 'utf8'), 'Added.\n')
    assert.equal(await readlink(join(work, 'out', 'pages', 'latest')), 'a.md')
    assert.equal(await readFile(join(work, 'site', 'index.md'), 'utf8'), '# Home\nmore\n')
    assert.equal(await readFile(join(work, 'notes.md'), 'utf8'), 'buy milk\n')
  } finally {
    await service.release(HOST, sessionId)
  }
  await assert.rejects(run('docker', ['container', 'inspect', box]), /No such container/u)
})

test('a real box runs a tau\'s init in the agent\'s working directory, which reads the run\'s context, and a run of a tau from the box reaches the backend as the box\'s run\'s', { skip: await absent(IMAGE) }, async (t) => {
  const { work, tauDir, call } = await fixture(t)
  await withInit(tauDir)
  await writeFile(join(tauDir, 'init.mts'), [
    'import { mkdirSync, readFileSync, writeFileSync } from "node:fs"',
    'import { twice } from "kit"',
    'const { files, args } = JSON.parse(readFileSync(process.env.TAU_CONTEXT as string, "utf8"))',
    'writeFileSync(files.report, `${twice(args.style)}\\n`)',
    'mkdirSync(files.pages, { recursive: true })',
    'console.log(`${twice("done")} in ${process.cwd()}`)',
  ].join('\n'))
  const sessions = new FakeSessions()
  let service: TauService & { tauRuns: TauRuns } | undefined
  const fleet = await realFleet(t, work, () => service as TauService & { tauRuns: TauRuns })
  service = make(work, () => {}, sessions, fleet)
  const { sessionId, box } = await startIn(service, HOST, tauDir, call, work)
  try {
    assert.deepEqual(await finish(service, HOST, sessionId), { ok: true, text: 'done, done in /tau/workspace\n' })
    assert.equal(await readFile(join(work, 'out', 'report.md'), 'utf8'), 'terse, terse\n')
    assert.equal(sessions.calls.length, 1)
    // The box's tau command reaches the backend, through the tau service, as this run's session, whose child its run is.
    const held = await service.tauRuns.boxFor(sessionId)
    const started = await held?.request('exec', { argv: ['sh', '-c', 'mkdir -p /tmp/child && echo Hi. > /tmp/child/PROMPT.md && cd /tmp && tau start child'] })
    assert.equal(started?.stderr, '')
    const child = String(started?.stdout).trim().slice('socket:'.length)
    assert.deepEqual((await service.list(from(sessionId))).map(status => [status.sessionId, status.parent, status.title]), [[child, sessionId, 'child']])
    await service.release(HOST, child)
  } finally {
    await service.release(HOST, sessionId)
  }
  await assert.rejects(run('docker', ['container', 'inspect', box]), /No such container/u)
})
