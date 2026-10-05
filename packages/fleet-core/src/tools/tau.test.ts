import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { extractBlob, readCall, writeResult, type CallJson, type Targets } from '@sleepymug/tau/call'
import type { About } from '../tau/runs.ts'
import type { Caller } from '../tau/registry.ts'
import { abortable } from '../tau/service.ts'
import { apply } from './tau.ts'

const SESSION = 'session-00000000-0000-4000-8000-000000000000'
const RUN = 'session-11111111-1111-4111-8111-111111111111'

/** A session's working directory with a tau that takes a text, a file to read and a file to write, and the file to read. */
async function fixture(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), 'fleet-tau-run-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  await mkdir(join(work, 'tau'))
  await writeFile(join(work, 'tau', 'PROMPT.md'), 'Summarize ${notes} in ${style} words into ${report}.\n')
  await writeFile(join(work, 'tau', 'tau.json'), JSON.stringify({
    params: {
      style: { type: 'text', description: 'How.' },
      notes: { type: 'file', mode: 'in', description: 'What.' },
      report: { type: 'file', mode: 'out', description: 'The summary.' },
    },
  }))
  await writeFile(join(work, 'notes.md'), 'buy milk\n')
  await mkdir(join(work, 'out'))
  return work
}

/**
 * The tau service, as the tool uses it: it reads the call it is started
 * with, and gives back, once {@link end} is called, a result that put
 * `report` at the `/report` handle, with the targets it was given.
 */
class FakeTau {
  readonly calls: string[] = []
  /** Settles once the tool waits for the run. */
  readonly finishing = Promise.withResolvers<void>()
  started: { caller: Caller; about: About; json: CallJson; notes: string } | undefined
  private readonly ending = Promise.withResolvers<void>()

  constructor(private readonly work: string) {}

  async start(caller: Caller, about: About, archive: AsyncIterable<Uint8Array>): Promise<{ sessionId: string }> {
    const { json, blobs } = await readCall(archive)
    await mkdir(join(this.work, 'call'))
    for await (const blob of blobs) await extractBlob(blob, join(this.work, 'call', blob.id))
    this.started = { caller, about, json, notes: await readFile(join(this.work, 'call', 'b0'), 'utf8') }
    return { sessionId: RUN }
  }

  async finish(caller: Caller, sessionId: string, signal: AbortSignal): Promise<{ result: unknown; targets: Targets; archive: AsyncIterable<Uint8Array> }> {
    this.calls.push(`finish ${caller.kind === 'session' ? caller.sessionId : 'host'} ${sessionId}`)
    this.finishing.resolve()
    await abortable(this.ending.promise, signal)
    await writeFile(join(this.work, 'left.md'), 'Milk.\n')
    const archive = writeResult({ ok: true, text: 'Done.', outputs: { '/report': { $out: { name: 'report.md', kind: 'file', blob: 'o0' } } } }, [{ id: 'o0', path: join(this.work, 'left.md') }])
    return { result: { ok: true, text: 'Done.' }, targets: this.started?.about.targets ?? {}, archive }
  }

  async cancel(caller: Caller, sessionId: string): Promise<void> {
    this.calls.push(`cancel ${caller.kind === 'session' ? caller.sessionId : 'host'} ${sessionId}`)
  }

  end(): void {
    this.ending.resolve()
  }
}

/** `tau_run`, registered on a context whose tau service is `tau`. */
function toolOn(tau: FakeTau): ToolDefinition {
  let tool: ToolDefinition | undefined
  const systemPrompt = { section: () => {}, getSectionOrder: () => 0 }
  apply({ tools: { register: (registered: ToolDefinition) => { tool = registered } }, systemPrompt, fleetTau: tau } as unknown as Context)
  assert.ok(tool !== undefined)
  return tool
}

/** A call of the tool from the session, in `cwd`. */
function execIn(cwd: string, signal = new AbortController().signal): ToolRunContext {
  return { agent: { session: { header: { id: SESSION, cwd } } }, signal } as unknown as ToolRunContext
}

test('tau_run packs the call from the session\'s folder, runs it as the session\'s, and puts what it gave back at the session\'s paths', async (t) => {
  const work = await fixture(t)
  const tau = new FakeTau(work)
  const tool = toolOn(tau)
  assert.equal(tool.isConcurrencySafe?.({ tau: 'tau' }), true)
  const values = { style: 'few', notes: { $in: 'notes.md' }, report: { $out: 'out/report.md' } }
  const running = tool.execute({ tau: 'tau', values }, execIn(work))
  await Promise.race([tau.finishing.promise, running])
  assert.deepEqual(tau.started?.caller, { kind: 'session', sessionId: SESSION })
  assert.deepEqual(tau.started?.about, { title: 'tau', project: work, targets: { '/report': join(work, 'out', 'report.md') } })
  assert.deepEqual(tau.started?.json.values, { style: 'few', notes: { $in: { name: 'notes.md', kind: 'file', blob: 'b0' } }, report: { $out: { name: 'report.md' } } })
  assert.equal(tau.started?.notes, 'buy milk\n')
  tau.end()
  assert.deepEqual(await running, { sessionId: RUN, ok: true, text: 'Done.' })
  assert.equal(await readFile(join(work, 'out', 'report.md'), 'utf8'), 'Milk.\n')
  assert.deepEqual(tau.calls, [`finish ${SESSION} ${RUN}`])
})

test('tau_run refuses values that do not fit the tau before it starts a run', async (t) => {
  const work = await fixture(t)
  const tau = new FakeTau(work)
  await assert.rejects(toolOn(tau).execute({ tau: 'tau', values: { style: 'few' } }, execIn(work)), /notes/u)
  assert.equal(tau.started, undefined)
})

test('cancelling tau_run cancels the run, and puts nothing at the session\'s paths', async (t) => {
  const work = await fixture(t)
  const tau = new FakeTau(work)
  const cancelling = new AbortController()
  const values = { style: 'few', notes: { $in: 'notes.md' }, report: { $out: 'out/report.md' } }
  const running = toolOn(tau).execute({ tau: join(work, 'tau'), values }, execIn(work, cancelling.signal))
  await Promise.race([tau.finishing.promise, running])
  cancelling.abort()
  await assert.rejects(running)
  assert.deepEqual(tau.calls, [`finish ${SESSION} ${RUN}`, `cancel ${SESSION} ${RUN}`])
  await assert.rejects(readFile(join(work, 'out', 'report.md')), /ENOENT/u)
})

test('a session with tau_run has tau\'s TAU.md in its prompt, and one without it does not', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  const registered = new Map<string, ToolDefinition>()
  let enabled = true
  const tools = { register: (tool: ToolDefinition) => { registered.set(tool.name, tool) }, get: (name: string) => enabled ? registered.get(name) : undefined }
  apply({ tools, systemPrompt: ctx.systemPrompt, fleetTau: {} } as unknown as Context)
  const primer = await readFile(fileURLToPath(import.meta.resolve('@sleepymug/tau/TAU.md')), 'utf8')
  assert.match(primer, /^# TAU \(Transportable Agent Unit\)/u)
  assert.equal((await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'tool:tau')?.text, primer)
  enabled = false
  assert.equal((await ctx.systemPrompt.assemble()).sections.find(section => section.name === 'tool:tau')?.text ?? '', '')
})
