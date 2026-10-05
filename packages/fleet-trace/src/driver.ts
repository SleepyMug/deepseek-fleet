/**
 * fleet-trace's driver, a dsh plugin that the scratch profile mounts
 * (./run.ts): on its socket, it makes a session as the web UI does, in a
 * folder's dsh workspace, with the profile's default agent preset, gives it
 * a prompt, waits until its agent is done with it, and answers with why its
 * last turn ended and the last text its agent wrote. One request, one line
 * of JSON, each way. The services' types are written out here as far as
 * they are used, so this module imports nothing of dsh's.
 * @module fleet-trace/driver
 */

import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'

/** What the driver asks of dsh. */
export interface Services {
  workspaceRegistry: { create(path: string): Promise<{ id: string }> }
  sessionController: {
    create(request: { sessionId: string; workspaceId: string }): Promise<unknown>
    prompt(request: { requestId: string; sessionId: string; mode: 'queue'; content: { type: 'text'; text: string }[] }, signal: AbortSignal): Promise<unknown>
    inspect(sessionId: string, signal: AbortSignal): Promise<{ events: readonly { type: string; data?: unknown }[] }>
  }
  agents: { get(sessionId: string): { whenIdle(): Promise<unknown> } | undefined }
}

/** A request: a session in `project`'s workspace, given `prompt`. */
export interface Request {
  project: string
  prompt: string
}

/** How a session's last turn went: the session, why the turn ended, as dsh logs it, and the last text its agent wrote. */
export interface Settled {
  sessionId: string
  end: unknown
  text: string
}

export const name = 'fleet-trace-driver'
export const inject = ['workspaceRegistry', 'sessionController', 'agents']

export interface Config {
  /** Where it listens. */
  socket: string
}

export async function apply(ctx: Services & { effect(execute: () => () => void, label?: string): void }, config: Config): Promise<void> {
  rmSync(config.socket, { force: true })
  const server = createServer((socket) => { serve(ctx, socket) })
  await new Promise<void>((resolve) => { server.listen(config.socket, resolve) })
  ctx.effect(() => () => { server.close() }, 'fleet-trace driver')
}

/** Make a session, prompt it, and wait until its agent is done. */
export async function settle(services: Services, { project, prompt }: Request): Promise<Settled> {
  const signal = new AbortController().signal
  const workspace = await services.workspaceRegistry.create(project)
  const sessionId = `session-${randomUUID()}`
  await services.sessionController.create({ sessionId, workspaceId: workspace.id })
  await services.sessionController.prompt({ requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] }, signal)
  // An accepted prompt has woken the agent already, so idle means it is done with it.
  await services.agents.get(sessionId)?.whenIdle()
  let end: unknown
  let text = ''
  for (const { type, data } of (await services.sessionController.inspect(sessionId, signal)).events) {
    if (type === 'turn/end') end = (data as { reason?: unknown } | undefined)?.reason
    if (type === 'assistant/message') {
      const content = (data as { message?: { content?: readonly { type: string; text?: string }[] } } | undefined)?.message?.content ?? []
      const joined = content.map(block => block.type === 'text' ? block.text ?? '' : '').join('')
      if (joined !== '') text = joined
    }
  }
  return { sessionId, end, text }
}

function serve(services: Services, socket: Socket): void {
  let line = ''
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on('data', (chunk: string) => {
    line += chunk
    if (!line.includes('\n')) return
    socket.removeAllListeners('data')
    let request: Request
    try {
      request = JSON.parse(line) as Request
    } catch {
      socket.end(`${JSON.stringify({ error: 'the request is not JSON' })}\n`)
      return
    }
    settle(services, request).then(
      (settled) => { socket.end(`${JSON.stringify({ ok: settled })}\n`) },
      (error: unknown) => { socket.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`) },
    )
  })
}
