/**
 * The helper. The host starts it in a box with `docker exec --interactive`,
 * and it answers the host's requests over its stdin and stdout
 * (./protocol.ts) until its stdin ends.
 * @module fleet-image/helper/main
 */

import { createInterface } from 'node:readline'
import { PROTOCOL_VERSION, type HelperMessage, type HostMessage, type Method, type Methods } from './protocol.ts'

type Handlers = { [M in Method]: (params: Methods[M]['params']) => Promise<Methods[M]['result']> | Methods[M]['result'] }

const handlers: Handlers = {
  hello: () => ({ protocol: PROTOCOL_VERSION }),
  echo: (params) => {
    if (typeof params?.text !== 'string') throw new Error('echo takes a text')
    return { text: params.text }
  },
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => { void handle(line) })

async function handle(line: string): Promise<void> {
  let request: HostMessage
  try {
    request = JSON.parse(line) as HostMessage
  } catch {
    process.stderr.write('fleet-helper: unreadable message\n')
    return
  }
  const { id, method, params } = request
  try {
    if (!Object.hasOwn(handlers, method)) throw new Error(`unknown method ${method}`)
    send({ type: 'result', id, value: await handlers[method as Method](params as never) })
  } catch (error) {
    send({ type: 'error', id, message: error instanceof Error ? error.message : String(error) })
  }
}

function send(message: HelperMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
