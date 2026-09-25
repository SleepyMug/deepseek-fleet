/**
 * The fleet execution world (`ctx.fleetWorld`). Every root session owns one
 * Docker container, opened whenever one of its agents is created, and one
 * dsh-ssh helper inside it that serves the session's files and processes to
 * dsh's SSH providers. The session folder is bind-mounted at the same absolute
 * path, and the container's `/tmp` is a private host folder under the user's
 * runtime directory, kept short so the host can reach the helper's sockets
 * there. Processes run as the container's root, which rootless Docker maps to
 * the host user, so files in the workspace stay the user's. Subagent sessions
 * share their root's container. The image is built from this package's
 * `image/` folder at startup. Containers used by this process are stopped, not
 * removed, when it exits.
 * @module fleet-world/world
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service } from '@deepseek-ai/cordis'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { DockerConnection } from './connection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetWorld: FleetWorld
  }
}

const SESSION_LABEL = 'fleet.world.session'
/** Digest of a container's `docker run` arguments; a mismatch means the container is out of date. */
const SPEC_LABEL = 'fleet.world.spec'

/** The image definition this package builds; every file below it feeds the image tag. */
const IMAGE_CONTEXT = fileURLToPath(new URL('../image/', import.meta.url))
/** Where `image/Dockerfile` installs Node and the dsh-ssh helper. */
const HELPER_NODE = '/usr/local/bin/node'
const HELPER_ENTRY = '/opt/fleet-world/helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js'
/** dsh-ssh's defaults for the helper's request deadline and heartbeat lease. */
const HELPER_REQUEST_TIMEOUT_MS = 30_000
const HELPER_LEASE_MS = 30_000

/** Hex digits of the session-id digest naming a session's `/tmp` folder. */
const TMP_KEY_LENGTH = 12
/**
 * The longest socket path the dsh-ssh helper creates below `/tmp`: its
 * `mkdtemp('/tmp/dsh-ssh-')` root, a process UUID, then the channel name.
 */
const HELPER_SOCKET_TAIL = `/dsh-ssh-XXXXXX/${'0'.repeat(36)}/terminal`
/** Linux `sun_path` holds 108 bytes including the terminating NUL. */
const MAX_SOCKET_PATH_BYTES = 107

export interface Config {
  /** Docker CLI executable. */
  docker: string
  /** Host directory holding each session's private `/tmp`; short enough for the helper's socket paths. */
  runtimeDir: string
  /** Deadline for one Docker CLI call other than an image build. */
  dockerTimeoutMs: number
  /** Grace `docker stop` gives a container before killing it. */
  stopTimeoutSeconds: number
}

/** One root session's container. */
export interface SessionContainer {
  /** Docker container name. */
  name: string
  /** Host folder bind-mounted at the same path. */
  workspace: string
  /** Host folder, under the runtime directory, mounted at the container's `/tmp`. */
  tmp: string
}

/** One root session's container and the providers serving it. */
export interface SessionWorld {
  container: SessionContainer
  fs: FileSystem
  subprocess: SubprocessRuntime
}

/** An open world, with the connection loss that ends it and the release of its providers. */
interface OpenWorld {
  world: SessionWorld
  lost: Promise<Error>
  close(): Promise<void>
}

export class FleetWorld extends Service {
  static inject = ['sessions', 'agents']

  static Config: Schema<Config> = Schema.object({
    docker: Schema.string().default('docker').description('Docker CLI executable.'),
    runtimeDir: Schema.string()
      .default(process.env.XDG_RUNTIME_DIR === undefined ? '' : join(process.env.XDG_RUNTIME_DIR, 'fleet-world'))
      .description("Host directory holding each session's private /tmp; short enough for the helper's socket paths."),
    dockerTimeoutMs: Schema.number().default(60_000).description('Deadline for one Docker CLI call other than an image build.'),
    stopTimeoutSeconds: Schema.number().default(5).description('Grace docker stop gives a container before killing it.'),
  })

  private readonly config: Config
  /** Worlds by root session, opening or open; a failed or lost world is forgotten so the next use opens a new one. */
  private readonly worlds = new Map<SessionId, Promise<OpenWorld>>()
  /** The open worlds, for synchronous callers. */
  private readonly open = new Map<SessionId, SessionWorld>()
  /** Containers this process started or found running, by root session; each is stopped on exit. */
  private readonly containers = new Map<SessionId, SessionContainer>()
  private image = ''
  private helperHash = ''

  constructor(ctx: Context, config: Config) {
    super(ctx, 'fleetWorld')
    if (config.runtimeDir === '') throw new Error('fleet-world: XDG_RUNTIME_DIR is not set; configure runtimeDir')
    if (!isAbsolute(config.runtimeDir)) throw new Error(`fleet-world: runtimeDir must be absolute, got ${config.runtimeDir}`)
    const longest = join(config.runtimeDir, '0'.repeat(TMP_KEY_LENGTH)) + HELPER_SOCKET_TAIL
    if (Buffer.byteLength(longest) > MAX_SOCKET_PATH_BYTES) {
      throw new Error(`fleet-world: runtimeDir ${config.runtimeDir} is too long; helper sockets under it would take ${Buffer.byteLength(longest)} of at most ${MAX_SOCKET_PATH_BYTES} bytes`)
    }
    this.config = config
    // Serial and awaited: a Docker or helper failure rolls back the agent creation instead of leaving a session without its world.
    ctx.on('agent/created', ({ agent }) => this.forAgent(agent).then(() => undefined))
    // Registered before any world, so every world's providers are released before the containers stop.
    ctx.effect(() => () => this.stopAll(), 'fleet-world session containers')
  }

  /** Build the image before any session needs it; a missing Docker fails startup. */
  async [Service.init](): Promise<void> {
    const helper = await readFile(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-ssh/helper')))
    this.helperHash = createHash('sha256').update(helper).digest('hex')
    this.image = await this.buildImage()
  }

  /**
   * The world of the session whose agent initiated the current call.
   * @param operation - the provider method, named in the error for a call outside any session.
   * @returns the initiating agent and its root session's open world.
   */
  async current(operation: string): Promise<{ agent: Agent; world: SessionWorld }> {
    const agent = this.initiator(operation)
    return { agent, world: await this.forAgent(agent) }
  }

  /**
   * The same for a synchronous call, which needs the world open already. A
   * world still opening, or reconnecting after its helper was lost, fails the
   * call and keeps opening.
   * @param operation - the provider method, named in the error.
   * @returns the initiating agent's open world.
   */
  currentOpen(operation: string): SessionWorld {
    const root = this.rootHeader(this.initiator(operation).session.header)
    const world = this.open.get(root.id)
    if (world !== undefined) return world
    this.forRoot(root).catch((error: unknown) => {
      this.ctx.logger.warn(`fleet-world: could not open the container of session ${root.id}: ${error instanceof Error ? error.message : String(error)}`)
    })
    throw new Error(`fleet-world: ${operation} found the container of session ${root.id} still connecting; try again`)
  }

  /**
   * Open the world of an agent's root session.
   * @param agent - any agent of the session.
   * @returns the root session's world, its container running and its helper connected.
   */
  forAgent(agent: Agent): Promise<SessionWorld> {
    return this.forRoot(this.rootHeader(agent.session.header))
  }

  /**
   * Open a root session's world once; a failed attempt, or a world whose
   * helper connection is lost, is replaced on the next use.
   * @param root - header of a session that is not a subagent.
   * @returns the session's open world.
   */
  forRoot(root: SessionHeader): Promise<SessionWorld> {
    let opening = this.worlds.get(root.id)
    if (opening === undefined) {
      const attempt = this.openWorld(root)
      opening = attempt
      this.worlds.set(root.id, attempt)
      const forget = (): boolean => {
        if (this.worlds.get(root.id) !== attempt) return false
        this.worlds.delete(root.id)
        this.open.delete(root.id)
        return true
      }
      attempt.then(({ world, lost, close }) => {
        if (this.worlds.get(root.id) === attempt) this.open.set(root.id, world)
        void lost.then(async (error) => {
          if (forget()) this.ctx.logger.warn(`fleet-world: lost the helper in ${world.container.name}, ending its running commands; the next use reconnects: ${error.message}`)
          await close()
        })
      }, forget)
    }
    return opening.then(({ world }) => world)
  }

  private initiator(operation: string): Agent {
    const agent = this.ctx.agents.currentInitiator()
    if (agent === undefined) throw new Error(`fleet-world: ${operation} was called outside a session; the container world serves only session work`)
    return agent
  }

  /**
   * The root session whose container a session uses: subagent sessions walk
   * up to their parent, the same lineage the archive gate follows.
   */
  private rootHeader(header: SessionHeader): SessionHeader {
    const visited = new Set<SessionId>()
    let current = header
    while (current.origin === 'subagent' && current.parentSession !== undefined && !visited.has(current.id)) {
      visited.add(current.id)
      const parent = this.ctx.sessions.get(current.parentSession)
      if (parent === undefined) {
        throw new Error(`fleet-world: subagent session ${current.id} has parent ${current.parentSession}, which is not loaded, so its container is unknown`)
      }
      current = parent.header
    }
    return current
  }

  /**
   * Start the session's container and connect a helper in it. The world's
   * `ssh`, `fs` and `subprocess` live in their own scope below this service,
   * apart from the global `fs` and `subprocess`, which route to them.
   */
  private async openWorld(root: SessionHeader): Promise<OpenWorld> {
    const container = await this.ensureContainer(root)
    const scope = this.ctx.isolate('ssh').isolate('fs').isolate('subprocess')
    const fibers: Fiber[] = []
    const close = async (): Promise<void> => {
      for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
    }
    try {
      const loads = [
        () => scope.plugin(DockerConnection, {
          docker: this.config.docker, container: container.name, workspace: container.workspace, tmp: container.tmp,
          node: HELPER_NODE, helper: HELPER_ENTRY, helperHash: this.helperHash,
          requestTimeoutMs: HELPER_REQUEST_TIMEOUT_MS, leaseMs: HELPER_LEASE_MS,
        }),
        () => scope.plugin(SshFileSystem),
        () => scope.plugin(SshSubprocessRuntime),
      ]
      for (const load of loads) {
        const fiber = load()
        fibers.push(fiber)
        await fiber
      }
    } catch (error) {
      await close()
      throw error
    }
    const connection = scope.get('ssh') as unknown as DockerConnection | undefined
    const fs = scope.get('fs')
    const subprocess = scope.get('subprocess')
    if (connection === undefined || fs === undefined || subprocess === undefined) {
      await close()
      throw new Error(`fleet-world: the providers for ${container.name} did not start`)
    }
    return { world: { container, fs, subprocess }, lost: connection.lost, close }
  }

  /** Create, recreate, or start the root session's container. */
  private async ensureContainer(root: SessionHeader): Promise<SessionContainer> {
    const workspace = root.cwd
    if (workspace === undefined || !isAbsolute(workspace)) {
      throw new Error(`fleet-world: session ${root.id} has no absolute folder to mount (cwd: ${String(workspace)})`)
    }
    // `--mount` parses comma-separated fields.
    if (/[,\n]/u.test(workspace)) throw new Error(`fleet-world: cannot mount a folder whose path contains a comma or newline: ${workspace}`)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(root.id)) throw new Error(`fleet-world: session id ${root.id} is not usable as a container name`)
    const container: SessionContainer = {
      name: `fleet-${root.id}`,
      workspace,
      tmp: join(this.config.runtimeDir, createHash('sha256').update(root.id).digest('hex').slice(0, TMP_KEY_LENGTH)),
    }
    await mkdir(container.tmp, { recursive: true, mode: 0o700 })

    const runArgs = [
      '--init',
      '--mount', `type=bind,src=${workspace},dst=${workspace}`,
      '--mount', `type=bind,src=${container.tmp},dst=/tmp`,
      '--workdir', workspace,
      this.image, 'sleep', 'infinity',
    ]
    const spec = createHash('sha256').update(JSON.stringify(runArgs)).digest('hex').slice(0, 16)
    const existing = await this.inspect(container.name)
    if (existing?.spec === spec) {
      if (!existing.running) await this.docker(['start', container.name])
    } else {
      if (existing !== undefined) {
        this.ctx.logger.warn(`fleet-world: recreating ${container.name}; its image or mounts changed, so changes outside ${workspace} and /tmp are lost`)
        await this.docker(['rm', '--force', container.name])
      }
      await this.docker([
        'run', '--detach', '--name', container.name,
        '--label', `${SESSION_LABEL}=${root.id}`, '--label', `${SPEC_LABEL}=${spec}`,
        ...runArgs,
      ])
    }
    this.containers.set(root.id, container)
    return container
  }

  /** Build the session image unless its tag, a digest of `image/`, already exists. */
  private async buildImage(): Promise<string> {
    const digest = createHash('sha256')
    const files = (await readdir(IMAGE_CONTEXT, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile())
      .map(entry => relative(IMAGE_CONTEXT, join(entry.parentPath, entry.name)))
      .sort()
    for (const file of files) digest.update(`${file}\0`).update(await readFile(join(IMAGE_CONTEXT, file))).update('\0')
    const tag = `fleet-world:${digest.digest('hex').slice(0, 12)}`
    const present = await this.docker(['image', 'inspect', tag]).then(() => true, () => false)
    if (!present) {
      this.ctx.logger.info(`fleet-world: building image ${tag}; the first build takes a minute`)
      await this.docker(['build', '--quiet', '--tag', tag, IMAGE_CONTEXT], 0)
    }
    return tag
  }

  /** @returns the container's state, or undefined when no such container exists. */
  private async inspect(name: string): Promise<{ running: boolean; spec: string } | undefined> {
    let state: string
    try {
      state = await this.docker(['container', 'inspect', '--format', `{{.State.Running}} {{index .Config.Labels "${SPEC_LABEL}"}}`, name])
    } catch (error) {
      if (error instanceof Error && /no such (object|container)/iu.test(error.message)) return undefined
      throw error
    }
    const [running = '', spec = ''] = state.split(' ')
    return { running: running === 'true', spec }
  }

  /** Stop every container this process used; they stay until their session is archived. */
  private async stopAll(): Promise<void> {
    const names = [...this.containers.values()].map(container => container.name)
    this.containers.clear()
    if (names.length === 0) return
    await this.docker(['stop', '--time', String(this.config.stopTimeoutSeconds), ...names],
      this.config.dockerTimeoutMs + this.config.stopTimeoutSeconds * 1000)
  }

  /**
   * Run one Docker CLI command.
   * @param timeoutMs - 0 waits without a deadline.
   * @returns trimmed stdout; a failure carries Docker's stderr.
   */
  private docker(args: string[], timeoutMs = this.config.dockerTimeoutMs): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.config.docker, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error === null) resolve(stdout.trim())
        else reject(new Error(`fleet-world: docker ${args[0]} failed: ${stderr.trim() || error.message}`, { cause: error }))
      })
    })
  }
}

export default FleetWorld
