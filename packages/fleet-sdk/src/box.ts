/**
 * One of the gateway's boxes, as a client asks of it: its life, through
 * the gateway's `Boxes`, which the client says, the box running from its
 * start until it is stopped; and its API, `fleet.box.v1.Box`, which the
 * gateway carries to the helper of the box, started. A watch lasts as long
 * as its call, and is taken again once a lost connection is made again.
 * @module @sleepymug/fleet-sdk/box
 */

import { createWriteStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { basename } from 'node:path'
import { create } from '@bufbuild/protobuf'
import { Code, ConnectError, createClient, type CallOptions, type Client } from '@connectrpc/connect'
import { Box as BoxService, type ExecResponse, GetRequestSchema, PutRequestSchema } from '@sleepymug/fleet-protocol/box'
import { type Box, Boxes, BoxState } from '@sleepymug/fleet-protocol/gateway'
import { boxPath } from '@sleepymug/fleet-protocol/wire'
import { connectTransport, type Upstream } from '@sleepymug/fleet-net'
import { packTree, pathEntry, unpackTree, writeTar } from '@sleepymug/fleet-pack'

/** What follows a box's state: told it now, at each change, and `removed` once the box is gone. */
export type BoxListener = (state: BoxState | 'removed') => void

/** A program, as `exec` runs it. */
export interface ExecOptions {
  /** Its working folder; `/` without it. */
  cwd?: string
  /** What it adds to the box's environment. */
  env?: Record<string, string>
  /** Its input; none without it. */
  stdin?: Uint8Array | string
}

export class FleetBox {
  /** The box's API, of the box started; a call of a box that is not fails, `NOT_STARTED`. */
  readonly api: Client<typeof BoxService>

  /** @param closing - aborted as the client closes, which ends its watches. */
  constructor(readonly id: string, private readonly boxes: Client<typeof Boxes>, upstream: Upstream, private readonly closing: AbortSignal) {
    this.api = createClient(BoxService, connectTransport(upstream, boxPath(id)))
  }

  /** The box, with its state. */
  info(options?: CallOptions): Promise<Box> {
    return this.boxes.get({ box: this.id }, options)
  }

  /** Start the box, if it is not started, and settle once it is: it runs until it is stopped. */
  async start(): Promise<void> {
    await this.boxes.start({ box: this.id })
  }

  /** Stop the box, whatever runs in it; what is in it stays. */
  async stop(): Promise<void> {
    await this.boxes.stop({ box: this.id })
  }

  async remove(): Promise<void> {
    await this.boxes.remove({ box: this.id })
  }

  /** Follow the box's state: `listener` is told it now, at each change, and `removed` once the box is gone, until the returned stop. */
  watch(listener: BoxListener): () => void {
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.closing])
    void (async () => {
      for (let pause = 100; !signal.aborted;) {
        try {
          for await (const { state } of this.boxes.watch({ box: this.id }, { signal })) {
            listener(state)
            pause = 100
          }
          if (!signal.aborted) listener('removed')
          return
        } catch (error) {
          if (signal.aborted) return
          if (gone(error)) {
            listener('removed')
            return
          }
        }
        await sleep(pause, signal)
        pause = Math.min(pause * 2, 2000)
      }
    })()
    return () => { controller.abort() }
  }

  /** Run a program in the box to its end, and give back how it ended and what it wrote. */
  exec(argv: string[], { cwd, env, stdin }: ExecOptions = {}): Promise<ExecResponse> {
    return this.api.exec({ program: { argv, cwd: cwd ?? '/', env: env ?? {} }, ...stdin === undefined ? {} : { stdin: typeof stdin === 'string' ? Buffer.from(stdin) : stdin } })
  }

  /** Run a program in the box, and give back what it wrote to stdout; an exit other than 0 fails, with what it wrote to stderr. */
  async output(argv: string[], options: ExecOptions = {}): Promise<string> {
    const { exit, stdout, stderr } = await this.exec(argv, options)
    if (exit?.code !== 0) {
      const how = exit?.signal !== undefined && exit.signal !== '' ? `was ended by ${exit.signal}` : `exited with ${String(exit?.code)}`
      const said = Buffer.from(stderr).toString().trim()
      throw new Error(`fleet: ${argv[0] ?? ''} in ${this.id} ${how}${said === '' ? '' : `: ${said}`}`)
    }
    return Buffer.from(stdout).toString()
  }

  /** Unpack a tar archive into a folder of the box. */
  async put(archive: AsyncIterable<Uint8Array>, to: string): Promise<void> {
    async function* requests() {
      yield create(PutRequestSchema, { request: { case: 'path', value: to } })
      for await (const chunk of archive) yield create(PutRequestSchema, { request: { case: 'chunk', value: chunk } })
    }
    await this.api.put(requests())
  }

  /** Copy a folder's contents on this machine into a folder of the box, or a file into it under its own name. */
  async putPath(from: string, to: string): Promise<void> {
    if ((await lstat(from)).isDirectory()) {
      await this.put(packTree(from), to)
      return
    }
    const entry = await pathEntry(from, basename(from))
    if (entry === undefined) throw new Error(`fleet: ${from} is neither a file, a folder nor a symlink`)
    await this.put(writeTar([entry]), to)
  }

  /** A folder of the box's contents, or a file under its own name, as a tar archive. */
  async *get(from: string): AsyncGenerator<Uint8Array> {
    for await (const { chunk } of this.api.get(create(GetRequestSchema, { path: from }))) yield chunk
  }

  /** Copy a folder of the box's contents, or a file of it, into a folder on this machine. */
  async getPath(from: string, to: string): Promise<void> {
    await unpackTree(this.get(from), to, { what: `${from} of ${this.id}` })
  }

  /** Copy a file of the box to a file on this machine. */
  async getFile(from: string, to: string): Promise<void> {
    const out = createWriteStream(to)
    try {
      for await (const { chunk } of this.api.readFile({ path: from })) {
        if (!out.write(chunk)) await new Promise<void>((resolve) => { out.once('drain', resolve) })
      }
    } finally {
      await new Promise<void>((resolve, reject) => { out.end((error?: Error | null) => (error ? reject(error) : resolve())) })
    }
  }
}

/** Whether a failure says the box is gone, so that nothing is to be taken again. */
function gone(error: unknown): boolean {
  const code = ConnectError.from(error).code
  return code === Code.NotFound || code === Code.FailedPrecondition || code === Code.Canceled
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export { BoxState }
