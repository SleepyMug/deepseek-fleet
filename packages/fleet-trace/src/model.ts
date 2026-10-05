/**
 * The scripted model: an OpenAI-compatible chat endpoint on localhost, which
 * dsh's `llm-pi-ai` reaches as the provider `mock`. It answers the run's
 * conversation, a request carrying the tau's prompt, with the scenario's
 * next step, one per tool result it has had back, and its final text after
 * the last; any other request, such as dsh's for a session title, with a
 * word. It writes each request it gets, whole, to its folder.
 * @module fleet-trace/model
 */

import { writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

/** One step of a scenario: a call of a tool, with its arguments. */
export interface Step {
  tool: string
  args: Record<string, unknown>
}

interface Message {
  role: string
  content?: unknown
}

export class ScriptedModel {
  /** The tau's prompt, which marks the run's conversation, once the run is created. */
  prompt: string | undefined
  /** The requests written, in order: their files, and whether each was the run's. */
  readonly requests: { file: string; run: boolean }[] = []
  private readonly finished = Promise.withResolvers<void>()

  private constructor(
    private readonly server: Server,
    private readonly steps: readonly Step[],
    private readonly final: string,
    private readonly dir: string,
  ) {}

  /** Listen on a free port of localhost; requests are written to `dir`. */
  static async start(steps: readonly Step[], final: string, dir: string): Promise<ScriptedModel> {
    let model: ScriptedModel | undefined
    const server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: Buffer) => { raw += chunk.toString() })
      request.on('end', () => { model?.answer(raw, response) })
    })
    model = new ScriptedModel(server, steps, final, dir)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    return model
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port
  }

  /** Settles once the run's conversation has had the final text. */
  get done(): Promise<void> {
    return this.finished.promise
  }

  close(): Promise<void> {
    this.server.closeAllConnections()
    return new Promise((resolve) => { this.server.close(() => { resolve() }) })
  }

  private answer(raw: string, response: import('node:http').ServerResponse): void {
    const body = JSON.parse(raw === '' ? '{}' : raw) as { messages?: Message[] }
    const messages = body.messages ?? []
    const run = this.prompt !== undefined && messages.some(message => message.role === 'user' && text(message).includes(this.prompt as string))
    const file = join(this.dir, `${String(this.requests.length + 1).padStart(3, '0')}${run ? '-run' : ''}.json`)
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`)
    this.requests.push({ file, run })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const id = `mock-${this.requests.length}`
    const chunk = (delta: object, finish: string | null): string =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const step = run ? this.steps[messages.filter(message => message.role === 'tool').length] : undefined
    if (step !== undefined) {
      const call = { index: 0, id: `call_${this.requests.length}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }
      response.write(chunk({ role: 'assistant', tool_calls: [call] }, null))
      response.write(chunk({}, 'tool_calls'))
    } else {
      response.write(chunk({ role: 'assistant', content: run ? this.final : 'Title' }, null))
      response.write(chunk({}, 'stop'))
      const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
      response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-model', choices: [], usage })}\n\n`)
    }
    response.end('data: [DONE]\n\n')
    if (run && step === undefined) this.finished.resolve()
  }
}

/** A message's text, whether a string or a list of parts. */
export function text(message: Message): string {
  const { content } = message
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '').join('')
}
