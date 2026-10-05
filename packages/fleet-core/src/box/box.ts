/**
 * A box: one Docker container, and fleet's helper in it while it runs
 * (docs/fleet-core/box/index.md). The container stays until it is removed,
 * through any number of starts and stops.
 * @module fleet-core/box
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { posix, resolve } from 'node:path'
import { DEFAULT_IMAGE, HELPER_ENTRY, HELPER_NODE } from 'fleet-image/layout'
import type { EventOf, Method, Methods } from 'fleet-image/helper/protocol'
import { Helper, type CallHandler } from './helper.ts'

export { HelperError, METHODS, type CallHandler } from './helper.ts'
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

/** Nothing is at a path in a box that a copy reads. */
export class MissingInBox extends Error {}

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
   * Copy a host file or folder, whole, to a path in the container that is
   * not there yet, whether the box runs or not, with `docker cp`. Symlinks
   * are copied as links, the path's own included, and modes are kept.
   * @param from - the host path.
   * @param to - the container's path, absolute, whose parent exists.
   */
  copyInWhole(from: string, to: string): Promise<void> {
    return this.serial(async () => {
      await run(this.docker, ['cp', resolve(from), `${this.container}:${containerPath(to)}`])
    })
  }

  /**
   * Copy a container file or folder, whole, to a host path that is not
   * there yet, whether the box runs or not, with `docker cp`. Symlinks are
   * copied as links, the path's own included, and modes are kept.
   * @param from - the container's path, absolute.
   * @param to - the host path, whose parent exists.
   * @throws {@link MissingInBox} when nothing is at `from`.
   */
  copyOutWhole(from: string, to: string): Promise<void> {
    return this.serial(async () => {
      try {
        await run(this.docker, ['cp', `${this.container}:${containerPath(from)}`, resolve(to)])
      } catch (error) {
        if (/Could not find the file/u.test((error as Error).message)) throw new MissingInBox(`fleet: nothing is at ${from} in ${this.container}`, { cause: error })
        throw error
      }
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
