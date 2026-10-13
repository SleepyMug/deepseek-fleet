/**
 * The helper, put together from what it is given: it answers the host's
 * requests (./protocol.ts), read as lines from its input, each answered on
 * its output, until its input ends; then it ends the processes, terminals
 * and watches it started, and answers what it was still asked. It also
 * relays the calls of the extensions' clients in the box to the host
 * (./cmd/calls.ts). Each helper has processes, terminals and files of its
 * own (./cmd/), so nothing of one is another's.
 * @module @sleepymug/fleet-box-runtime/helper/serve
 */

import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { CallSocket } from './cmd/calls.ts'
import { exec } from './cmd/exec.ts'
import { Files } from './cmd/fs.ts'
import { apisLink } from './cmd/link.ts'
import { Processes } from './cmd/spawn.ts'
import { Terminals } from './cmd/terminal.ts'
import { PROTOCOL_VERSION, type EventOf, type HelperMessage, type HostMessage, type Method, type Methods } from './protocol.ts'

export interface HelperIo {
  /** The host's messages, a line of JSON each. */
  input: Readable
  /** Where the helper's messages go, a line of JSON each. */
  output: Writable
  /** The helper's environment, which every process it starts starts from, and in which it names its call socket. */
  env: Record<string, string | undefined>
  /** The folder relative paths without a `cwd` are in. */
  cwd: string
  /** Say what went wrong outside the protocol. */
  log(message: string): void
}

/** Sends one of the request's events; false when the host has fallen behind. */
type Emit<M extends Method> = (event: EventOf<M>) => boolean

type Handlers = {
  [M in Method]: (params: Methods[M]['params'], emit: Emit<M>) => Promise<Methods[M]['result']> | Methods[M]['result']
}

/** Serve the host until the input ends, and everything the helper started has ended. */
export async function serve({ input, output, env, cwd, log }: HelperIo): Promise<void> {
  const files = new Files(cwd)
  const processes = new Processes(env)
  const terminals = new Terminals(env)
  const send = (message: HelperMessage): boolean => output.write(`${JSON.stringify(message)}\n`)

  const handlers: Handlers = {
    hello: () => ({ protocol: PROTOCOL_VERSION, methods: Object.keys(handlers) }),
    echo: (params) => {
      if (typeof params?.text !== 'string') throw new Error('echo takes a text')
      return { text: params.text }
    },
    exec,
    'fs.resolve': params => files.resolve(params),
    'fs.stat': params => files.stat(params),
    'fs.lstat': params => files.lstat(params),
    'fs.readText': params => files.readText(params),
    'fs.readBytes': params => files.readBytes(params),
    'fs.readRange': params => files.readRange(params),
    'fs.listDir': params => files.listDir(params),
    'fs.writeText': params => files.writeText(params),
    'fs.editText': params => files.editText(params),
    'fs.watch': (params, emit) => files.watch(params, emit),
    'fs.unwatch': params => files.unwatch(params),
    spawn: (params, emit) => processes.spawn(params, { send: emit, onDrain: (listener) => { output.on('drain', listener) } }),
    kill: params => processes.kill(params),
    which: params => processes.which(params),
    terminal: (params, emit) => terminals.start(params, { send: emit, onDrain: (listener) => { output.once('drain', listener) } }),
    'terminal.write': params => terminals.write(params),
    'terminal.resize': params => terminals.resize(params),
    'terminal.foreground': params => terminals.foreground(params),
    'terminal.activity': params => terminals.activity(params),
    'terminal.signal': params => terminals.signal(params),
    'terminal.end': params => terminals.end(params),
    'apis.link': apisLink,
  }

  /** Requests not answered yet. */
  const inFlight = new Set<Promise<void>>()

  const handle = async ({ id, method, params }: Extract<HostMessage, { type: 'request' }>): Promise<void> => {
    try {
      if (!Object.hasOwn(handlers, method)) throw new Error(`unknown method ${method}`)
      const emit = (value: unknown): boolean => send({ type: 'event', id, value })
      send({ type: 'result', id, value: await handlers[method as Method](params as never, emit as never) })
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      send({ type: 'error', id, message: error instanceof Error ? error.message : String(error), ...typeof code === 'string' ? { code } : {} })
    }
  }

  // Before any request, so that every process the helper starts finds the socket. Without it, only calls fail.
  const calls = await CallSocket.listen(send, env).catch((error: unknown) => {
    log(`no call socket: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  })

  const lines = createInterface({ input, crlfDelay: Infinity })
  const closed = new Promise<void>((resolve) => { lines.once('close', resolve) })
  lines.on('line', (line) => {
    let message: HostMessage
    try {
      message = JSON.parse(line) as HostMessage
    } catch {
      log('unreadable message')
      return
    }
    if (message.type === 'call-result' || message.type === 'call-error' || message.type === 'call-data' || message.type === 'call-end') {
      calls?.answer(message)
      return
    }
    const handled = handle(message)
    inFlight.add(handled)
    void handled.finally(() => { inFlight.delete(handled) })
  })
  // The host has gone, or is done with the box: what it asked is answered, its processes, terminals and watches ended first.
  await closed
  await Promise.allSettled([processes.killAll(), terminals.endAll(), files.unwatchAll(), calls?.close()])
  await Promise.allSettled([...inFlight])
}
