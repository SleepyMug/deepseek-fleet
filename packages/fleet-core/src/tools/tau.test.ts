import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { extractContent, readCall, writeResult, type CallJson, type Targets } from '@sleepymug/tau/call'
import type { About } from '../tau/runs.ts'
import type { Caller } from '../tau/registry.ts'
import { abortable } from '../tau/service.ts'
import { apply } from './tau.ts'

const SESSION = 'session-00000000-0000-4000-8000-000000000000'
const RUN = 'session-11111111-1111-4111-8111-111111111111'

/** A session's working directory with a tau that takes a file to read, a file to write and an arg, and the file to read. */
async function fixture(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), 'fleet-tau-run-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  await mkdir(join(work, 'tau'))
  await writeFile(join(work, 'tau', 'PROMPT.md'), 'Summarize ${notes} in ${style} words into ${report}.\n')
  await writeFile(join(work, 'tau', 'tau.json'), JSON.stringify({
    files: {
      notes: { kind: 'file', mode: 'in', description: 'What.' },
      report: { kind: 'file', mode: 'out', description: 'The summary.' },
    },
    args: { type: 'object', properties: { style: { type: 'string', description: 'How.' } }, required: ['style'] },
  }))
  await writeFile(join(work, 'notes.md'), 'buy milk\n')
  await mkdir(join(work, 'out'))
  return work
}

/**
 * The tau service, as the tool uses it: it reads the call it is started
 * with, and gives back, once {@link end} is called, a result that put
 * `report` at the file `report`, with the targets it was given.
 */
class FakeTau {
  readonly calls: string[] = []
  /** Settles once the tool waits for the run. */
  readonly finishing = Promise.withResolvers<void>()
  started: { caller: Caller; about: About; json: CallJson; notes: string } | undefined
  private readonly ending = Promise.withResolvers<void>()

  constructor(private readonly work: string) {}

  async start(caller: Caller, about: About, archive: AsyncIterable<Uint8Array>): Promise<{ sessionId: string }> {
    const { json, contents } = await readCall(archive)
    await mkdir(join(this.work, 'call'))
    for await (const content of contents) await extractContent(content, join(this.work, 'call', content.file ?? 'tau'))
    this.started = { caller, about, json, notes: await readFile(join(this.work, 'call', 'notes'), 'utf8') }
    return { sessionId: RUN }
  }

  async finish(caller: Caller, sessionId: string, signal: AbortSignal, options?: { history?: boolean }): Promise<{ result: unknown; targets: Targets; history?: unknown[]; archive: AsyncIterable<Uint8Array> }> {
    this.calls.push(`finish ${caller.kind === 'session' ? caller.sessionId : 'host'} ${sessionId}${options?.history === true ? ' with history' : ''}`)
    this.finishing.resolve()
    await abortable(this.ending.promise, signal)
    await writeFile(join(this.work, 'left.md'), 'Milk.\n')
    const archive = writeResult({ ok: true, text: 'Done.', outputs: { report: { kind: 'file' } } }, [{ file: 'report', from: join(this.work, 'left.md') }])
    const history = options?.history === true ? { history: [{ type: 'user/message' }, { type: 'turn/end' }] } : {}
    return { result: { ok: true, text: 'Done.' }, targets: this.started?.about.targets ?? {}, ...history, archive }
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
  const running = tool.execute({ tau: 'tau', files: { notes: 'notes.md', report: 'out/report.md' }, args: { style: 'few, as ${notes} has it' } }, execIn(work))
  await Promise.race([tau.finishing.promise, running])
  assert.deepEqual(tau.started?.caller, { kind: 'session', sessionId: SESSION })
  assert.deepEqual(tau.started?.about, { title: 'tau', project: work, targets: { report: join(work, 'out', 'report.md') } })
  assert.deepEqual(tau.started?.json.files, { notes: { mode: 'in', base: 'notes.md', kind: 'file' }, report: { mode: 'out', base: 'report.md' } })
  assert.deepEqual(tau.started?.json.args, { style: 'few, as ${notes} has it' })
  assert.equal(tau.started?.notes, 'buy milk\n')
  tau.end()
  assert.deepEqual(await running, { sessionId: RUN, ok: true, text: 'Done.' })
  assert.equal(await readFile(join(work, 'out', 'report.md'), 'utf8'), 'Milk.\n')
  assert.deepEqual(tau.calls, [`finish ${SESSION} ${RUN}`])
})

test('tau_run writes the run\'s session\'s history where it is asked to, a relative path the session\'s', async (t) => {
  const work = await fixture(t)
  const tau = new FakeTau(work)
  const running = toolOn(tau).execute({ tau: 'tau', files: { notes: 'notes.md', report: 'out/report.md' }, args: { style: 'few' }, history: 'logs/run.jsonl' }, execIn(work))
  await Promise.race([tau.finishing.promise, running])
  tau.end()
  assert.deepEqual(await running, { sessionId: RUN, ok: true, text: 'Done.' })
  assert.equal(await readFile(join(work, 'logs', 'run.jsonl'), 'utf8'), '{"type":"user/message"}\n{"type":"turn/end"}\n')
  assert.deepEqual(tau.calls, [`finish ${SESSION} ${RUN} with history`])
})

test('tau_run refuses a call that does not fit the tau before it starts a run', async (t) => {
  const work = await fixture(t)
  const tau = new FakeTau(work)
  await assert.rejects(toolOn(tau).execute({ tau: 'tau', args: { style: 'few' } }, execIn(work)), /no path for notes, report/u)
  assert.equal(tau.started, undefined)
})

test('cancelling tau_run cancels the run, and puts nothing at the session\'s paths', async (t) => {
  const work = await fixture(t)
  const tau = new FakeTau(work)
  const cancelling = new AbortController()
  const running = toolOn(tau).execute({ tau: join(work, 'tau'), files: { notes: 'notes.md', report: 'out/report.md' }, args: { style: 'few' } }, execIn(work, cancelling.signal))
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
