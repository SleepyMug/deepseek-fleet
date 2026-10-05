/**
 * What the model was sent, as files to read: of one request, the system
 * prompt as it is, each tool as the model gets it, and the conversation,
 * each call with its arguments and each result as sent.
 * @module fleet-trace/render
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { text } from './model.ts'

interface Request {
  messages?: { role: string; content?: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[]
  tools?: { function: { name: string } }[]
}

/**
 * Write a request's system prompt to `system-prompt.md`, each tool to
 * `tools/<name>.json`, and the rest of its messages to `conversation.md`.
 */
export function render(request: Request, out: string): void {
  const messages = request.messages ?? []
  writeFileSync(join(out, 'system-prompt.md'), `${messages.filter(message => message.role === 'system').map(text).join('\n')}\n`)
  mkdirSync(join(out, 'tools'), { recursive: true })
  for (const tool of request.tools ?? []) writeFileSync(join(out, 'tools', `${tool.function.name}.json`), `${JSON.stringify(tool, null, 2)}\n`)
  const parts: string[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') parts.push(`## user\n\n${text(message)}\n`)
    if (message.role === 'assistant') {
      if (text(message) !== '') parts.push(`## assistant\n\n${text(message)}\n`)
      for (const call of message.tool_calls ?? []) parts.push(`## assistant calls ${call.function.name} (${call.id})\n\n${argumentsOf(call.function.arguments)}`)
    }
    if (message.role === 'tool') {
      const result = text(message)
      parts.push(`## tool result (${message.tool_call_id ?? '?'})${result.startsWith('Error: ') ? ', an error' : ''}\n\n${fenced(result)}${indented(result)}`)
    }
  }
  writeFileSync(join(out, 'conversation.md'), parts.join('\n'))
}

/** A call's arguments; a program's source in a block of its own. */
function argumentsOf(json: string): string {
  const args = JSON.parse(json) as Record<string, unknown>
  if (typeof args.source !== 'string') return `${fenced(JSON.stringify(args, null, 2), 'json')}`
  const { source, ...rest } = args
  return `${fenced(JSON.stringify(rest, null, 2), 'json')}\n${fenced(source, 'ts')}`
}

/** A result that is JSON, an error's after its `Error: `, indented, after the result as sent. */
function indented(result: string): string {
  try {
    return `\nindented:\n\n${fenced(JSON.stringify(JSON.parse(result.replace(/^Error: /u, '')), null, 2), 'json')}`
  } catch {
    return ''
  }
}

/** A fenced block, its fence longer than any run of backticks in the text. */
function fenced(body: string, language = ''): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/gu)].map(match => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${language}\n${body.replace(/\n$/u, '')}\n${fence}\n`
}
