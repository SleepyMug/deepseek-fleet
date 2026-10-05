import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as TauPrompt from './prompt.ts'

test('a tau\'s prompt says where the model works, and leaves out dsh\'s sections about the host', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(TauPrompt)
  ctx.systemPrompt.variable('cwd', () => '/home/me/notes')
  ctx.systemPrompt.section({ name: 'harness:source', order: ctx.systemPrompt.getSectionOrder('HARNESS_SOURCE'), text: 'The checkout is at /host/dsh.' })
  ctx.systemPrompt.section({ name: 'tool:bash', order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'), text: 'Check the exit code.' })
  const { sections, variables } = await ctx.systemPrompt.assemble()
  assert.deepEqual(sections.map(section => section.name).filter(name => name !== 'deployment:persona-prefix' && name !== 'deployment:persona-suffix'), [
    'harness:identity', 'fleet:tau-where', 'tool:bash',
  ])
  const where = sections.find(section => section.name === 'fleet:tau-where')?.text ?? ''
  assert.match(where.replace('{{cwd}}', variables.cwd ?? ''), /Your working directory is \/home\/me\/notes, a folder of the box/u)
  for (const folder of ['/tau/in', '/tau/workspace', '/tau/out', '/tau/self']) assert.ok(where.includes(`- ${folder}:`), folder)
})
