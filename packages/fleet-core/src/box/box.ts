/**
 * A box: one Docker container, and fleet's helper in it while it runs
 * (docs/fleet-core/box/index.md). The container stays until it is removed,
 * through any number of starts and stops.
 * @module fleet-core/box
 */

import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import { Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DEFAULT_IMAGE, HELPER_ENTRY, HELPER_NODE } from 'fleet-box-runtime/layout'
import type { EventOf, Method, Methods } from 'fleet-box-runtime/helper/protocol'
import { Helper, type CallHandler } from './helper.ts'

export { HelperError, METHODS, STREAMED, streamed, type CallHandler, type Streamed } from './helper.ts'
export { exec } from './cmd/exec.ts'

/** The label every box's container carries, with an empty value, which `list` and `open` look for. */
export const BOX_LABEL = 'fleet.box'

export interface DockerOptions {
  /** Docker CLI executable; `docker` by default. */
  docker?: string
}

export interface BoxOptions extends DockerOptions {
  /** The image to run, as `pnpm image` builds it; {@link DEFAULT_IMAGE} by default. */
  image?: string
  /** The container's name; `fleet-box-` and a random suffix by default. */
  name?: string
}

/** A box's container as `list` finds it. */
export interface BoxInfo {
  /** The container's name. */
  name: string
  image: string
  /** Docker's state: `created`, `running`, `exited`, and so on. */
  state: string
  /** Docker's own summary, such as `Up 2 minutes`. */
  status: string
}

export class Box {
  /** The helper while the box is started. */
  private helper: Helper | undefined
  /** The last verb in progress; each verb waits for the one before it. */
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    /** The container's name. */
    readonly container: string,
    private readonly docker: string,
  ) {}

  /** Create a box's container, stopped. */
  static async create(options: BoxOptions = {}): Promise<Box> {
    const docker = options.docker ?? 'docker'
    const container = options.name ?? `fleet-box-${randomBytes(6).toString('hex')}`
    // An init as its first process, so `sleep` ends on the SIGTERM of `docker stop`.
    await run(docker, [
      'create', '--init', '--pull', 'never', '--name', container, '--label', BOX_LABEL,
      options.image ?? DEFAULT_IMAGE, 'sleep', 'infinity',
    ])
    return new Box(container, docker)
  }

  /**
   * A box whose container is there already, as `create` made it, running or
   * not; its helper, if one runs, is another process's.
   * @param name - the container's name or id.
   */
  static async open(name: string, options: DockerOptions = {}): Promise<Box> {
    const docker = options.docker ?? 'docker'
    const labels = JSON.parse(await run(docker, ['container', 'inspect', '--format', '{{json .Config.Labels}}', name])) as Record<string, string> | null
    if (labels === null || !Object.hasOwn(labels, BOX_LABEL)) throw new Error(`fleet: container ${name} is not a box`)
    return new Box(name, docker)
  }

  /** Every box's container, running or not. */
  static async list(options: DockerOptions = {}): Promise<BoxInfo[]> {
    const listed = await run(options.docker ?? 'docker', ['container', 'ls', '--all', '--filter', `label=${BOX_LABEL}`, '--format', '{{json .}}'])
    return listed.split('\n').filter(line => line !== '').map((line) => {
      const { Names, Image, State, Status } = JSON.parse(line) as Record<string, string>
      return { name: Names, image: Image, state: State, status: Status }
    })
  }

  /**
   * Start the container, if it is not running, and a new helper in it. A
   * start that fails leaves the container stopped.
   * @param onCall - answers the calls of the clients in the box, while this helper runs; without it, each fails.
   */
  start(onCall?: CallHandler): Promise<void> {
    return this.serial(async () => {
      await this.closeHelper()
      await run(this.docker, ['start', this.container])
      try {
        this.helper = await Helper.start([this.docker, 'exec', '--interactive', this.container, HELPER_NODE, HELPER_ENTRY], onCall)
      } catch (error) {
        await run(this.docker, ['stop', this.container]).catch(() => {})
        throw error
      }
    })
  }

  /**
   * Ask the helper of the started box.
   * @param onEvent - told each event the request sends before its result.
   * @returns its checked result; a failure the helper reports is a HelperError.
   */
  request<M extends Method>(method: M, params: Methods[M]['params'], onEvent?: (event: EventOf<M>) => void): Promise<Methods[M]['result']> {
    if (this.helper === undefined) return Promise.reject(new Error(`fleet: box ${this.container} is not started`))
    return this.helper.request(method, params, onEvent)
  }

  /** End the helper and stop the container, which keeps what is in it. */
  stop(): Promise<void> {
    return this.serial(async () => {
      await this.closeHelper()
      await run(this.docker, ['stop', this.container])
    })
  }

  /**
   * Copy a host file, or a host folder's contents, into the container,
   * whether it runs or not, with `docker cp`: a file to the path `to`, and a
   * folder's contents into the folder `to`, which is made if missing. The
   * parent of `to` must exist; what is already in a folder stays unless a
   * copied file takes its place. Symlinks are copied as links.
   * @param from - the host file or folder.
   * @param to - the container's path, absolute.
   */
  copyIn(from: string, to: string): Promise<void> {
    return this.serial(async () => {
      const source = (await stat(from)).isDirectory() ? `${resolve(from)}/.` : resolve(from)
      await run(this.docker, ['cp', source, `${this.container}:${containerPath(to)}`])
    })
  }

  /**
   * Copy a container folder's contents into a host folder, whether the box
   * runs or not, with `docker cp`, on the same terms as {@link copyIn}.
   * @param from - the container's folder, an absolute path.
   * @param to - the host folder.
   */
  copyOut(from: string, to: string): Promise<void> {
    return this.serial(async () => {
      await run(this.docker, ['cp', `${this.container}:${containerPath(from)}/.`, resolve(to)])
    })
  }

  /**
   * Run a program in the started container, without a shell and outside the
   * helper, with `docker exec`, for bytes the helper's lines of JSON would
   * carry only as text: `input`, if given, its stdin, and its stdout written
   * to `output`, if given, which ends with it.
   * @throws when it exits with other than 0, with what it wrote to stderr.
   */
  pipe(argv: string[], io: { input?: AsyncIterable<Uint8Array>; output?: Writable } = {}): Promise<void> {
    return this.serial(async () => {
      const child = spawn(this.docker, ['exec', '--interactive', this.container, ...argv], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => { stderr += chunk })
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      const streams = await Promise.allSettled([
        pipeline(Readable.from(io.input ?? []), child.stdin),
        io.output === undefined ? new Promise<void>((resolve) => { child.stdout.resume().once('end', resolve) }) : pipeline(child.stdout, io.output),
      ])
      const code = await exited
      if (code !== 0) throw new Error(`fleet: ${String(argv[0])} in box ${this.container} exited with ${String(code)}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`)
      for (const stream of streams) if (stream.status === 'rejected') throw stream.reason
    })
  }

  /** End the helper and remove the container, running or not. */
  remove(): Promise<void> {
    return this.serial(async () => {
      await this.closeHelper()
      await run(this.docker, ['rm', '--force', this.container])
    })
  }

  private async closeHelper(): Promise<void> {
    const helper = this.helper
    this.helper = undefined
    await helper?.close()
  }

  private serial(verb: () => Promise<void>): Promise<void> {
    const done = this.queue.then(verb)
    this.queue = done.catch(() => {})
    return done
  }
}

function containerPath(path: string): string {
  if (!posix.isAbsolute(path)) throw new Error(`fleet: ${path} is not an absolute path in the container`)
  return path
}

function run(docker: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(docker, args, (error, stdout, stderr) => {
      if (error === null) resolve(stdout.trim())
      else reject(new Error(`fleet: docker ${args[0]} failed: ${stderr.trim() || error.message}`, { cause: error }))
    })
  })
}
