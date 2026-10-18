import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { SkillRegistry, isModelInvocable } from '@deepseek-ai/dsh-skill'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as TauPrompt from './prompt.ts'
import type { Entry } from '../tau/registry.ts'
import type { TauRuns } from '../tau/runs.ts'

const SESSION = 'session-00000000-0000-4000-8000-000000000000'

type Run = Pick<Entry, 'files' | 'exposed' | 'skills'>

/** A context with the prompt plugin, and the one tau's session `SESSION`, whose run `run` has. */
async function prompted(run: Partial<Run> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(SkillRegistry, {})
  const entry: Run = { files: {}, exposed: [], ...run }
  ctx.provide('fleetTauRuns', { isTau: (sessionId: string) => sessionId === SESSION, entry: async () => entry } as unknown as TauRuns)
  await ctx.plugin(TauPrompt)
  return ctx
}

/** The assembly for an agent of a session. */
function forSession(sessionId: string): AssembleContext {
  return { agent: { session: { header: { id: sessionId } } } } as unknown as AssembleContext
}

test('a tau\'s prompt says where the model works, how its run ends and where tau\'s primers are, and leaves out dsh\'s sections and runtime contexts about the host', async () => {
  const ctx = await prompted()
  const section = (name: string, order: Parameters<typeof ctx.systemPrompt.getSectionOrder>[0], text: string): void => { ctx.systemPrompt.section({ name, order: ctx.systemPrompt.getSectionOrder(order), text }) }
  section('harness:source', 'HARNESS_SOURCE', 'The checkout is at /host/dsh.')
  section('tool:bash', 'TOOL_BASH', 'Check the exit code.')
  section('tool:write', 'TOOL_WRITE', 'Read an existing file before overwriting it.')
  section('tool:edit', 'TOOL_EDIT', 'Read a file before editing it.')
  ctx.systemPrompt.context({ name: 'sandbox:policy', order: ctx.systemPrompt.getContextOrder('SANDBOX_POLICY'), text: 'Current DSH file policy: danger-full-access.' })
  ctx.systemPrompt.context({ name: 'approval:policy', order: ctx.systemPrompt.getContextOrder('APPROVAL_POLICY'), text: 'Approval prompts are disabled.' })
  const { sections, contexts } = await ctx.systemPrompt.assemble(forSession(SESSION))
  assert.deepEqual(contexts, [])
  assert.deepEqual(sections.map(section => section.name).filter(name => name !== 'deployment:persona-prefix' && name !== 'deployment:persona-suffix'), [
    'fleet:tau-where', 'tool:bash', 'tool:write',
  ])
  const where = sections.find(section => section.name === 'fleet:tau-where')?.text ?? ''
  assert.equal(where, TauPrompt.WHERE)
  assert.match(where, /^You work in a container of your own, as root, with network access: .* Your working directory is \/tau\/workspace\. The TAU's own directory, \/tau\/self, /u)
  assert.match(where, /your last message is the text your caller gets/u)
  assert.match(where, /\/tau\/TAU\.md says what a TAU takes, .* and \/tau\/TAU_DEV\.md how to make one/u)
  assert.equal(sections.find(section => section.name === 'tool:write')?.text, TauPrompt.READ_FIRST)
})

test('a tau\'s prompt lists the run\'s files, each with its mode, its kind, its place and what it is, after where the model works', async () => {
  const ctx = await prompted({
    files: {
      list: { mode: 'in', kind: 'file', base: 'list.txt', description: 'The list, {{one}} a line.', place: '/tau/in/list.txt' },
      site: { mode: 'inout', kind: 'dir', base: 'site', description: 'The pages.', place: '/tau/workspace/site' },
      extra: { mode: 'out', base: 'extra', place: '/tau/out/extra' },
    },
  })
  const { sections } = await ctx.systemPrompt.assemble(forSession(SESSION))
  const names = sections.map(section => section.name)
  assert.equal(names.indexOf('fleet:tau-files'), names.indexOf('fleet:tau-where') + 1)
  assert.equal(sections.find(section => section.name === 'fleet:tau-files')?.text, [
    'Your files:',
    '',
    '- `list`, in, a file, at /tau/in/list.txt: The list, {{one}} a line.',
    '- `site`, inout, a directory, at /tau/workspace/site: The pages.',
    '- `extra`, out, a file or a directory, at /tau/out/extra',
    '',
    'An in file is a copy of your caller\'s, for you to read. Leave a file or a directory, as each out and inout file\'s kind says, at its place, '
      + 'or the run fails, and your caller gets none of them. A directory you leave merges into your caller\'s: what you remove from it stays there.',
  ].join('\n'))
  // Only the rules of the modes the run has.
  assert.equal(TauPrompt.files({ files: { list: { mode: 'in', kind: 'file', base: 'list.txt', place: '/tau/in/list.txt' } } }),
    'Your files:\n\n- `list`, in, a file, at /tau/in/list.txt\n\nAn in file is a copy of your caller\'s, for you to read.')
  // A run without files, and an entry written before the box reported places, get none.
  assert.equal(TauPrompt.files({ files: {} }), '')
  assert.equal(TauPrompt.files({ files: { list: { mode: 'in', kind: 'file', base: 'list.txt' } } }), '')
})

test('a tau\'s prompt says how the model runs its programs, and lists what its tau exposes to them, with where each is declared, after its files', async () => {
  const ctx = await prompted({
    files: { list: { mode: 'in', kind: 'file', base: 'list.txt', place: '/tau/in/list.txt' } },
    exposed: [{ specifier: '@test/notes', description: 'Notes, {{tagged}}.', declarations: '/tau/node_modules/.contracts/@test/notes' }, { specifier: 'notes-digest' }],
  })
  const { sections } = await ctx.systemPrompt.assemble(forSession(SESSION))
  const names = sections.map(section => section.name)
  assert.equal(names.indexOf('fleet:tau-programs'), names.indexOf('fleet:tau-files') + 1)
  const text = sections.find(section => section.name === 'fleet:tau-programs')?.text ?? ''
  assert.match(text, /^Run programs with bash's `node`, `workdir` \/tau\/self, so that their imports resolve as the TAU's code does: `node - <<'EOF'`, the program, then `EOF`\. /u)
  assert.match(text, /Give a program absolute paths/u)
  assert.match(text, /\n\n- `@test\/notes`, declared in \/tau\/node_modules\/\.contracts\/@test\/notes\/index\.d\.ts: Notes, \{\{tagged\}\}\.\n- `notes-digest`, in \/tau\/self\/node_modules\/notes-digest, whose package\.json names its declarations$/u)
  // A session not a tau's, and a tau that exposes nothing, get none.
  assert.ok(!(await ctx.systemPrompt.assemble(forSession('session-11111111-1111-4111-8111-111111111111'))).sections.some(section => section.name === 'fleet:tau-programs'))
  assert.ok(!(await (await prompted()).systemPrompt.assemble(forSession(SESSION))).sections.some(section => section.name === 'fleet:tau-programs'))
})

test('in a box, bash says what it does there, and the skill tool is hidden from a session whose tau has no skills', () => {
  const tool = (name: string, properties: Record<string, unknown> = {}): PromptAssembly['tools'][number] =>
    ({ name, description: `dsh's ${name}.`, parameters: { type: 'object', properties } })
  const assembly: PromptAssembly = {
    sections: [], contexts: [], variables: {},
    tools: [tool('bash', { command: { type: 'string' }, timeoutMs: { type: 'number', description: 'The executor applies its configured default and cap.' } }), tool('skill'), tool('read')],
  }
  const { tools } = TauPrompt.boxed(assembly, { files: {}, exposed: [], skills: [] })
  assert.deepEqual(tools.map(({ name }) => name), ['bash', 'read'])
  assert.equal(tools[0]?.description, TauPrompt.BASH)
  assert.deepEqual(tools[0]?.parameters, {
    type: 'object',
    properties: { command: { type: 'string' }, timeoutMs: { type: 'number', description: TauPrompt.BASH_TIMEOUT } },
  })
  assert.equal(tools[1]?.description, 'dsh\'s read.')
  // A tau with skills, or an entry written before skills were kept, keeps it.
  assert.deepEqual(TauPrompt.boxed(assembly, { files: {}, exposed: [], skills: ['greet'] }).tools.map(({ name }) => name), ['bash', 'skill', 'read'])
  assert.deepEqual(TauPrompt.boxed(assembly, { files: {}, exposed: [] }).tools.map(({ name }) => name), ['bash', 'skill', 'read'])
})

test('the preset shadows the skills of tau\'s primers, which the host has, for its agents alone, which cannot load them', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(SkillRegistry, {})
  ctx.provide('fleetTauRuns', { isTau: () => true, entry: async () => ({ files: {}, exposed: [] }) } as unknown as TauRuns)
  ctx.skills.register({ name: 'tau', description: 'TAU.md.', source: 'bundled', content: '# TAU' })
  ctx.skills.register({ name: 'tau-dev', description: 'TAU_DEV.md.', source: 'bundled', content: '# Making a TAU' })
  const preset = { preset: 'tau' }
  await createScope(ctx, preset).ctx.plugin(TauPrompt)
  const agent = { agent: 'a tau\'s' }
  bindScopeParent(agent, preset)
  const invocable = async (scope: object): Promise<string[]> => (await ctx.skills.list({ scope })).filter(isModelInvocable).map(({ name }) => name)
  assert.deepEqual(await invocable(agent), [])
  assert.deepEqual(await invocable({ agent: 'another' }), ['tau', 'tau-dev'])
})

test('the preset hides the host\'s tools, such as tau_run, from each of its agents, and from no other, as each is registered', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(SkillRegistry, {})
  await ctx.plugin(ToolRuntime, {})
  ctx.provide('fleetTauRuns', { isTau: () => true, entry: async () => ({ files: {}, exposed: [] }) } as unknown as TauRuns)
  const tool = (name: string): Parameters<typeof ctx.tools.register>[0] => defineContentToolFixture({ name, description: 'A tool.', parameters: {}, execute: async () => [] })
  ctx.tools.register(tool('web_fetch'))
  const preset = { preset: 'tau' }
  const presetCtx = createScope(ctx, preset).ctx
  await presetCtx.plugin(TauPrompt)
  // The preset's own, and one registered after the preset is mounted, as dsh may mount it first.
  await presetCtx.plugin({ inject: ['tools'], apply: (inner: Context) => { inner.tools.register(tool('bash')) } })
  ctx.tools.register(tool('tau_run'))
  const agent = { agent: 'a tau\'s' }
  bindScopeParent(agent, preset)
  assert.deepEqual(ctx.tools.schemas(agent).map(({ name }) => name), ['bash'])
  assert.deepEqual(ctx.tools.schemas({ agent: 'another' }).map(({ name }) => name).sort(), ['tau_run', 'web_fetch'])
})
