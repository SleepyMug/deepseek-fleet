/**
 * Boxes for the tests, without Docker: each a folder of the test's, with
 * the helper as built running on this machine as its "container", its
 * services' things in the folder, and a copy into the box's services' folder
 * a copy into that folder.
 * @module @sleepymug/fleet/local-boxes.test.util
 */

import { execFile } from 'node:child_process'
import { cp, mkdir, rm } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { Writable } from 'node:stream'
import { promisify } from 'node:util'
import { SERVICES_DIR } from '@sleepymug/fleet-protocol/layout'
import type { EventOf, Method, Methods } from '@sleepymug/fleet-protocol/helper'
import { Helper, type ConnectionHandler } from './box/helper.ts'
import type { Boxes, RunBox } from './managed.ts'

/** The helper as built, served on this Node, its services' things under `root`. */
export function localHelper(root: string): readonly [string, ...string[]] {
  const layout = { services: join(root, 'services'), bin: join(root, 'bin'), sockets: join(root, 'sockets') }
  const serve = JSON.stringify(import.meta.resolve('@sleepymug/fleet-box/helper/serve'))
  const program = [
    `import { serve } from ${serve}`,
    `await serve({ input: process.stdin, output: process.stdout, env: process.env, cwd: ${JSON.stringify(root)}, log: (message) => process.stderr.write(message), layout: ${JSON.stringify(layout)} })`,
    'process.exit(0)',
  ].join('\n')
  return [process.execPath, '--input-type=module', '--eval', program]
}

class LocalBox implements RunBox {
  private helper: Helper | undefined
  starts = 0

  constructor(readonly container: string, readonly root: string, private readonly boxes: LocalBoxes) {}

  async start(onConnection?: ConnectionHandler): Promise<void> {
    await this.helper?.close()
    this.starts++
    this.boxes.running.add(this.container)
    this.helper = await Helper.start(localHelper(this.root), onConnection)
  }

  request<M extends Method>(method: M, params: Methods[M]['params'], onEvent?: (event: EventOf<M>) => void): Promise<Methods[M]['result']> {
    if (this.helper === undefined) return Promise.reject(new Error(`${this.container} is not started`))
    return this.helper.request(method, params, onEvent)
  }

  async stop(): Promise<void> {
    await this.helper?.close()
    this.helper = undefined
    this.boxes.running.delete(this.container)
  }

  async remove(): Promise<void> {
    await this.stop()
    await rm(this.root, { recursive: true, force: true })
    this.boxes.made.delete(this.container)
  }

  /** A copy into the box's services' folder lands in its own; any other, under its root. */
  async copyIn(from: string, to: string): Promise<void> {
    const at = to.startsWith(`${SERVICES_DIR}/`) ? join(this.root, 'services', posix.relative(SERVICES_DIR, to)) : join(this.root, to)
    await mkdir(at, { recursive: true })
    await cp(from, at, { recursive: true, verbatimSymlinks: true })
  }

  async copyOut(from: string, to: string): Promise<void> {
    await cp(join(this.root, from), to, { recursive: true, verbatimSymlinks: true })
  }

  async pipe(argv: string[], io: { input?: AsyncIterable<Uint8Array>; output?: Writable } = {}): Promise<void> {
    const { stdout } = await promisify(execFile)(argv[0] as string, argv.slice(1), { cwd: this.root })
    io.output?.end(stdout)
  }
}

/** Where the tests' boxes are: each under `root`. */
export class LocalBoxes implements Boxes {
  readonly made = new Map<string, LocalBox>()
  readonly running = new Set<string>()

  constructor(private readonly root: string) {}

  async create(name: string): Promise<RunBox> {
    const box = new LocalBox(name, join(this.root, name), this)
    await mkdir(box.root, { recursive: true })
    this.made.set(name, box)
    return box
  }

  async open(name: string): Promise<RunBox> {
    const box = this.made.get(name)
    if (box === undefined) throw new Error(`no box ${name}`)
    return box
  }

  async state(name: string): Promise<'running' | 'stopped' | 'missing'> {
    if (!this.made.has(name)) return 'missing'
    return this.running.has(name) ? 'running' : 'stopped'
  }

  /** As if someone removed a box's container by other means. */
  async lose(name: string): Promise<void> {
    await this.made.get(name)?.remove()
  }
}
