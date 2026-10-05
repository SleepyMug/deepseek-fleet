/**
 * The scripted model: an OpenAI-compatible chat endpoint on localhost, which
 * dsh's `llm-pi-ai` reaches as the provider `mock`. It answers the
 * scenario's conversation, a request with tools carrying the prompt, the
 * tau's or the session's, with the scenario's next step, one per tool result
 * it has had back, and its final text after the last; the conversation of a
 * run the scenario starts, a request with tools carrying one of the
 * scenario's phrases, likewise, with that phrase's script; any other
 * request, such as dsh's for a session title, with a word. Until it is told
 * the prompt, which a run's start answers with, it holds every request. It
 * writes each request it gets, whole, to its folder.
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

/** What the model does in a run the scenario's run starts, whose prompt holds `match`. */
export interface Script {
  match: string
  steps: Step[]
  final: string
}

interface Message {
  role: string
  content?: unknown
}

export class ScriptedModel {
  /** The requests written, in order: their files, and whether each was the run's. */
  readonly requests: { file: string; run: boolean }[] = []
  /** The tau's prompt, which marks the run's conversation, once the run is started. */
  private readonly known = Promise.withResolvers<string>()

  private constructor(
    private readonly server: Server,
    private readonly steps: readonly Step[],
    private readonly final: string,
    private readonly dir: string,
    private readonly scripts: readonly Script[],
  ) {}

  /**
   * Listen on a free port of localhost; requests are written to `dir`.
   * @param scripts - what it does in the runs the run starts.
   */
  static async start(steps: readonly Step[], final: string, dir: string, scripts: readonly Script[] = []): Promise<ScriptedModel> {
    let model: ScriptedModel | undefined
    const server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: Buffer) => { raw += chunk.toString() })
      request.on('end', () => { void model?.answer(raw, response) })
    })
    model = new ScriptedModel(server, steps, final, dir, scripts)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    return model
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port
  }

  /** Tell the model the tau's prompt, which marks the run's conversation. */
  set prompt(text: string) {
    this.known.resolve(text)
  }

  close(): Promise<void> {
    this.server.closeAllConnections()
    return new Promise((resolve) => { this.server.close(() => { resolve() }) })
  }

  private async answer(raw: string, response: import('node:http').ServerResponse): Promise<void> {
    const body = JSON.parse(raw === '' ? '{}' : raw) as { messages?: Message[]; tools?: unknown[] }
    const messages = body.messages ?? []
    const prompt = await this.known.promise
    // A turn of a conversation offers tools; dsh's other requests, such as for a title, which may quote the prompt, do not.
    const turn = (body.tools ?? []).length > 0
    const says = (phrase: string): boolean => turn && messages.some(message => message.role === 'user' && text(message).includes(phrase))
    const run = says(prompt)
    const script = run ? { steps: this.steps, final: this.final } : this.scripts.find(({ match }) => says(match))
    const file = join(this.dir, `${String(this.requests.length + 1).padStart(3, '0')}${run ? '-run' : script === undefined ? '' : '-child'}.json`)
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`)
    this.requests.push({ file, run })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const id = `mock-${this.requests.length}`
    const chunk = (delta: object, finish: string | null): string =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const step = script?.steps[messages.filter(message => message.role === 'tool').length]
    if (step !== undefined) {
      const call = { index: 0, id: `call_${this.requests.length}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }
      response.write(chunk({ role: 'assistant', tool_calls: [call] }, null))
      response.write(chunk({}, 'tool_calls'))
    } else {
      response.write(chunk({ role: 'assistant', content: script?.final ?? 'Title' }, null))
      response.write(chunk({}, 'stop'))
      const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
      response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'mock-model', choices: [], usage })}\n\n`)
    }
    response.end('data: [DONE]\n\n')
  }
}

/** A message's text, whether a string or a list of parts. */
export function text(message: Message): string {
  const { content } = message
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '').join('')
}
