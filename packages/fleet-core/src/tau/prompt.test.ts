import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as TauPrompt from './prompt.ts'

test('a tau\'s prompt says where the model works, and leaves out dsh\'s sections and runtime context about the host', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(TauPrompt)
  ctx.systemPrompt.section({ name: 'harness:source', order: ctx.systemPrompt.getSectionOrder('HARNESS_SOURCE'), text: 'The checkout is at /host/dsh.' })
  ctx.systemPrompt.section({ name: 'tool:bash', order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'), text: 'Check the exit code.' })
  ctx.systemPrompt.context({ name: 'sandbox:policy', order: ctx.systemPrompt.getContextOrder('SANDBOX_POLICY'), text: 'Current DSH file policy: danger-full-access.' })
  ctx.systemPrompt.context({ name: 'approval:policy', order: ctx.systemPrompt.getContextOrder('APPROVAL_POLICY'), text: 'Approval prompts are disabled.' })
  const { sections, contexts } = await ctx.systemPrompt.assemble()
  assert.deepEqual(contexts.map(context => context.name), ['approval:policy'])
  assert.deepEqual(sections.map(section => section.name).filter(name => name !== 'deployment:persona-prefix' && name !== 'deployment:persona-suffix'), [
    'harness:identity', 'fleet:tau-where', 'tool:bash',
  ])
  assert.equal(
    sections.find(section => section.name === 'fleet:tau-where')?.text,
    'You work in a box of your own, a container, which your tools act on: bash, the file tools, and your TypeScript programs. Your working directory is /tau/workspace.',
  )
})
