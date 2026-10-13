import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as TauPrompt from './prompt.ts'
import type { Entry } from '../tau/registry.ts'
import type { TauRuns } from '../tau/runs.ts'

const SESSION = 'session-00000000-0000-4000-8000-000000000000'

/** A context with the prompt plugin, and the one tau's session `SESSION`, whose tau exposes `exposed`. */
async function prompted(exposed: Entry['exposed']): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  ctx.provide('fleetTauRuns', { isTau: (sessionId: string) => sessionId === SESSION, entry: async () => ({ exposed }) } as unknown as TauRuns)
  await ctx.plugin(TauPrompt)
  return ctx
}

/** The assembly for an agent of a session. */
function forSession(sessionId: string): AssembleContext {
  return { agent: { session: { header: { id: sessionId } } } } as unknown as AssembleContext
}

test('a tau\'s prompt says where the model works, and where TAU.md is, and leaves out dsh\'s sections and runtime context about the host', async () => {
  const ctx = await prompted([])
  ctx.systemPrompt.section({ name: 'harness:source', order: ctx.systemPrompt.getSectionOrder('HARNESS_SOURCE'), text: 'The checkout is at /host/dsh.' })
  ctx.systemPrompt.section({ name: 'tool:bash', order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'), text: 'Check the exit code.' })
  ctx.systemPrompt.context({ name: 'sandbox:policy', order: ctx.systemPrompt.getContextOrder('SANDBOX_POLICY'), text: 'Current DSH file policy: danger-full-access.' })
  ctx.systemPrompt.context({ name: 'approval:policy', order: ctx.systemPrompt.getContextOrder('APPROVAL_POLICY'), text: 'Approval prompts are disabled.' })
  const { sections, contexts } = await ctx.systemPrompt.assemble(forSession(SESSION))
  assert.deepEqual(contexts.map(context => context.name), ['approval:policy'])
  assert.deepEqual(sections.map(section => section.name).filter(name => name !== 'deployment:persona-prefix' && name !== 'deployment:persona-suffix'), [
    'harness:identity', 'fleet:tau-where', 'tool:bash',
  ])
  assert.equal(
    sections.find(section => section.name === 'fleet:tau-where')?.text,
    'You work in a box of your own, a container, which your tools act on: bash and the file tools. Your working directory is /tau/workspace. '
      + 'What a TAU is, and what a run of one promises, is in /tau/TAU.md.',
  )
})

test('a tau\'s prompt says how the model runs its programs, and lists what its tau exposes to them, after where it works', async () => {
  const ctx = await prompted([{ specifier: '@api/notes', description: 'Notes, {{tagged}}.' }, { specifier: 'notes-digest' }])
  const { sections } = await ctx.systemPrompt.assemble(forSession(SESSION))
  const names = sections.map(section => section.name)
  assert.equal(names.indexOf('fleet:tau-programs'), names.indexOf('fleet:tau-where') + 1)
  const text = sections.find(section => section.name === 'fleet:tau-programs')?.text ?? ''
  assert.match(text, /^You can run programs with `node`, from the TAU's directory: `cd \/tau\/self; node - <<'EOF'`, the program, then `EOF`\. This environment provides the modules below for them to import, resolving from \/tau\/self\. /u)
  assert.match(text, /\n\n- `@api\/notes`: Notes, \{\{tagged\}\}\.\n- `notes-digest`$/u)
  // A session not a tau's, and a tau that exposes nothing, get none.
  assert.ok(!(await ctx.systemPrompt.assemble(forSession('session-11111111-1111-4111-8111-111111111111'))).sections.some(section => section.name === 'fleet:tau-programs'))
  assert.ok(!(await (await prompted([])).systemPrompt.assemble(forSession(SESSION))).sections.some(section => section.name === 'fleet:tau-programs'))
})

test('the preset hides the host\'s tools, such as tau_run, from each of its agents, and from no other, as each is registered', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  ctx.provide('fleetTauRuns', { isTau: () => true, entry: async () => ({ exposed: [] }) } as unknown as TauRuns)
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
