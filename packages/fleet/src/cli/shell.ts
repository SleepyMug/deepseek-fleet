/**
 * `fleet box sh`: a terminal in a box, as `Box.Terminal` runs it, on this
 * one: what is typed goes to it, raw, what it writes comes here, and its
 * size follows this terminal's; it ends as its program does.
 * @module @sleepymug/fleet/cli/shell
 */

import { create } from '@bufbuild/protobuf'
import { type TerminalRequest, TerminalRequestSchema } from '@sleepymug/fleet-protocol/box'
import type { FleetBox } from '@sleepymug/fleet-sdk'

/** Run `argv` on a terminal in `box`, and give back its exit code. */
export async function shell(box: FleetBox, argv: string[]): Promise<number> {
  const input = process.stdin
  const output = process.stdout
  const size = (): { cols: number; rows: number } => ({ cols: output.columns ?? 80, rows: output.rows ?? 24 })
  const queue: TerminalRequest[] = [create(TerminalRequestSchema, { request: { case: 'start', value: { program: { argv }, size: size(), term: process.env.TERM ?? '' } } })]
  let wake: (() => void) | undefined
  let done = false
  const send = (request: TerminalRequest): void => {
    queue.push(request)
    wake?.()
  }
  async function* requests(): AsyncGenerator<TerminalRequest> {
    while (!done) {
      const next = queue.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      await new Promise<void>((resolve) => { wake = resolve })
      wake = undefined
    }
  }
  const onData = (data: Buffer): void => { send(create(TerminalRequestSchema, { request: { case: 'input', value: data } })) }
  const onResize = (): void => { send(create(TerminalRequestSchema, { request: { case: 'resize', value: size() } })) }
  if (input.isTTY) input.setRawMode(true)
  input.on('data', onData)
  output.on('resize', onResize)
  try {
    for await (const { response } of box.api.terminal(requests())) {
      if (response.case === 'output') output.write(response.value)
      if (response.case === 'exit') return response.value.code ?? 128
    }
    return 128
  } finally {
    done = true
    wake?.()
    input.off('data', onData)
    output.off('resize', onResize)
    if (input.isTTY) input.setRawMode(false)
    input.pause()
  }
}
