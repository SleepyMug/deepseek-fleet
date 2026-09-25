/**
 * fbox, the fleet's container execution world (`ctx.fbox`). Every root session
 * owns one Docker container for as long as it is unarchived, and one dsh-ssh
 * helper inside it that serves the session's files and processes to dsh's SSH
 * providers. The session folder is bind-mounted at the same absolute path, and
 * the container's `/tmp` is a private host folder under the user's runtime
 * directory, kept short so the host can reach the helper's sockets there.
 * Processes run as the container's root, which rootless Docker maps to the
 * host user, so files in the workspace stay the user's. Subagent sessions
 * share their root's container; a fork is its own root.
 *
 * Lifetime: a container runs exactly while this process has its session's
 * world open, its helper connected and dsh's providers serving it. A world
 * opens before a model step needs it, and its teardown always ends with the
 * container stopped, whether its helper was lost or dsh exits; the next use
 * starts it again. Archiving a session removes its container and `/tmp`
 * folder, and an unarchived session gets a fresh one on its next use. Startup
 * removes this dsh home's containers whose session is archived, or gone and
 * stopped. A container keeps running without a helper only when dsh is
 * killed, or exits before the teardown finishes; its next use takes it over.
 * The image is a prerequisite, built by this package's `fleet-setup`
 * command; without it this service does not start, dsh's startup warning
 * says how to build it, and no session can run.
 * @module fbox/world
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import type {} from '@deepseek-ai/dsh-workspace'
import { DockerConnection } from './connection.ts'
import { HELPER_ENTRY, HELPER_NODE, SETUP_ENTRY, helperHash, imageTag } from './image.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fbox: Fbox
  }
}

const SESSION_LABEL = 'fbox.session'
/** The dsh home a container's session belongs to; startup clean-up touches only its own home's containers. */
const HOME_LABEL = 'fbox.home'
/** Digest of a container's `docker run` arguments; a mismatch means the container is out of date. */
const SPEC_LABEL = 'fbox.spec'

/** dsh-ssh's defaults for the helper's request deadline and heartbeat lease. */
const HELPER_REQUEST_TIMEOUT_MS = 30_000
const HELPER_LEASE_MS = 30_000
/**
 * Grace `docker stop` gives the container's init. The helper has stopped
 * everything it started by then, leaving `sleep`, which exits on SIGTERM;
 * whatever escaped the helper is killed when the init exits, whatever the grace.
 */
const STOP_GRACE_SECONDS = 1

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
  /** Deadline for one Docker CLI call. */
  dockerTimeoutMs: number
}

/** One root session's container. */
export interface SessionContainer {
  /** Docker container name. */
  name: string
  /** Docker container id; a recreated container has a new one. */
  id: string
  /** When Docker created the container, in epoch milliseconds. */
  created: number
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

/** An open world and its teardown. */
interface OpenWorld {
  world: SessionWorld
  /** Tear the world down, whoever started it; settles once the container has stopped. */
  close(): Promise<void>
}

/** The owner of one root session's world. */
interface Root {
  /** Opening, teardown and removal run one at a time, in order. */
  queue: Promise<unknown>
  /** The open world; detached as soon as its teardown begins, so no call gets a closing world. */
  open: OpenWorld | undefined
}

export class Fbox extends Service {
  static inject = ['sessions', 'agents', 'workspaceRegistry', 'sessionPersistence']

  static Config: Schema<Config> = Schema.object({
    docker: Schema.string().default('docker').description('Docker CLI executable.'),
    runtimeDir: Schema.string()
      .default(process.env.XDG_RUNTIME_DIR === undefined ? '' : join(process.env.XDG_RUNTIME_DIR, 'fbox'))
      .description("Host directory holding each session's private /tmp; short enough for the helper's socket paths."),
    dockerTimeoutMs: Schema.number().default(60_000).description('Deadline for one Docker CLI call.'),
  })

  private readonly config: Config
  private readonly home = resolveDshHome()
  private readonly roots = new Map<SessionId, Root>()
  /** Sessions archived in the workspace registry, as of its latest write. */
  private archived: ReadonlySet<SessionId>
  /**
   * Settles once the image is found and stale containers are removed. Agents
   * can be created before that, and their worlds wait for it, so none opens
   * without an image or is mistaken for stale before its session is saved.
   */
  private readonly started = Promise.withResolvers<void>()
  private image = ''
  private helperHash = ''

  constructor(ctx: Context, config: Config) {
    super(ctx, 'fbox')
    if (config.runtimeDir === '') throw new Error('fbox: XDG_RUNTIME_DIR is not set; configure runtimeDir')
    if (!isAbsolute(config.runtimeDir)) throw new Error(`fbox: runtimeDir must be absolute, got ${config.runtimeDir}`)
    const longest = join(config.runtimeDir, '0'.repeat(TMP_KEY_LENGTH)) + HELPER_SOCKET_TAIL
    if (Buffer.byteLength(longest) > MAX_SOCKET_PATH_BYTES) {
      throw new Error(`fbox: runtimeDir ${config.runtimeDir} is too long; helper sockets under it would take ${Buffer.byteLength(longest)} of at most ${MAX_SOCKET_PATH_BYTES} bytes`)
    }
    this.config = config
    this.archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
    this.started.promise.catch(() => {})

    // Every step opens its world first: a synchronous spawn then finds it open, a session
    // unarchived while its agent stayed live gets a fresh container, and a Docker failure fails
    // the step rather than the session. A step in the middle of a turn often sends no new
    // messages yet still calls the model, so none is skipped. A cancelled step stops waiting;
    // the open goes on for the session's other agents. dsh's archive gate rejects the steps of
    // an archived session before they get here.
    ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      await this.forAgent(agent, signal)
      return decision
    }, { prepend: true })
    ctx.on('domain/changed', (change) => { this.followArchive(change) })
  }

  /** Find the image and clean up before any session needs them; without the image or Docker, this service does not start. */
  async [Service.init](): Promise<void> {
    try {
      this.helperHash = await helperHash()
      this.image = await imageTag()
      try {
        await this.docker(['image', 'inspect', '--format', '{{.Id}}', this.image])
      } catch (error) {
        if (!/no such image/iu.test(message(error))) throw error
        throw new Error(`fbox: the session image ${this.image} is not built; run: node ${SETUP_ENTRY}`)
      }
      await this.removeStale()
      this.started.resolve()
    } catch (error) {
      this.started.reject(error)
      throw error
    }
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
   * The same for a synchronous call, which needs the world open already. Each
   * model step opens it first, so this fails only for a world lost during
   * the step; the call fails and the world reopens.
   * @param operation - the provider method, named in the error.
   * @returns the initiating agent's open world.
   */
  currentOpen(operation: string): SessionWorld {
    const root = this.rootHeader(this.initiator(operation).session.header)
    if (this.archived.has(root.id)) throw archivedError(root.id)
    const world = this.roots.get(root.id)?.open?.world
    if (world !== undefined) return world
    this.forRoot(root).catch((error: unknown) => {
      this.ctx.logger.warn(`fbox: could not open the container of session ${root.id}: ${message(error)}`)
    })
    throw new Error(`fbox: ${operation} found the container of session ${root.id} still connecting; try again`)
  }

  /**
   * Open the world of an agent's root session.
   * @param agent - any agent of the session.
   * @param signal - stops waiting; the open goes on for the session's other agents.
   * @returns the root session's world, its container running and its helper connected.
   */
  forAgent(agent: Agent, signal?: AbortSignal): Promise<SessionWorld> {
    return this.forRoot(this.rootHeader(agent.session.header), signal)
  }

  /**
   * Open a root session's world, starting or creating its container; a world
   * whose helper was lost is replaced on the next use.
   * @param root - header of a session that is not a subagent.
   * @param signal - stops waiting; the open goes on for the session's other agents.
   * @returns the session's open world.
   * @throws when the session is archived, since its container was removed.
   */
  forRoot(root: SessionHeader, signal?: AbortSignal): Promise<SessionWorld> {
    const open = this.roots.get(root.id)?.open
    if (open !== undefined && !this.archived.has(root.id)) return Promise.resolve(open.world)
    // Wait outside the queue, which startup's clean-up uses too.
    const opening = this.started.promise.then(() => this.enqueue(root.id, async (state) => {
      if (this.archived.has(root.id)) throw archivedError(root.id)
      // The world serves the session and all its subagents, so it belongs to none of their agents.
      return (state.open ?? await this.ctx.agents.withoutInitiator(() => this.openWorld(root, state))).world
    }))
    return signal === undefined ? opening : abortable(opening, signal)
  }

  /** Run one container operation of a root session after the ones before it. */
  private enqueue<T>(id: SessionId, operation: (root: Root) => Promise<T>): Promise<T> {
    let root = this.roots.get(id)
    if (root === undefined) {
      root = { queue: Promise.resolve(), open: undefined }
      this.roots.set(id, root)
    }
    const state = root
    const result = state.queue.then(() => operation(state))
    state.queue = result.catch(() => {})
    return result
  }

  private initiator(operation: string): Agent {
    const agent = this.ctx.agents.currentInitiator()
    if (agent === undefined) throw new Error(`fbox: ${operation} was called outside a session; the container world serves only session work`)
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
        throw new Error(`fbox: subagent session ${current.id} has parent ${current.parentSession}, which is not loaded, so its container is unknown`)
      }
      current = parent.header
    }
    return current
  }

  /**
   * Follow the registry's archive list and remove the containers of newly
   * archived sessions. Archiving has no event of its own, but every archive
   * and unarchive rewrites the registry's storage, and that write carries the
   * whole new list; the registry's own getter lags until the write returns.
   * An unarchived session needs nothing here: its next use opens a fresh container.
   */
  private followArchive(change: DomainChanged): void {
    if (change.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return
    const value = change.value
    if (typeof value !== 'object' || value === null) return
    const ids = (value as { archivedSessionIds?: unknown }).archivedSessionIds
    if (!Array.isArray(ids)) return
    const previous = this.archived
    this.archived = new Set(ids as SessionId[])
    for (const id of this.archived) {
      if (previous.has(id)) continue
      this.remove(id).catch((error: unknown) => {
        this.ctx.logger.warn(`fbox: could not remove the container of archived session ${id}: ${message(error)}`)
      })
    }
  }

  /**
   * Remove a session's container and its `/tmp` folder; the workspace stays.
   * The world's teardown stops everything first. A subagent session owns no
   * container, so its id removes nothing.
   */
  private remove(id: SessionId): Promise<void> {
    return this.enqueue(id, async (state) => {
      const opened = state.open
      state.open = undefined
      await opened?.close()
      try {
        await this.docker(['rm', '--force', containerName(id)])
      } catch (error) {
        if (!isNoSuchContainer(error)) throw error
      }
      await rm(this.tmpFolder(id), { recursive: true, force: true })
    })
  }

  /**
   * Remove this dsh home's containers whose session is archived, or gone and
   * stopped: archived by a dsh process without this plugin, left by a crash
   * during a removal, or made for a new session that was never saved. A
   * running one may serve another dsh process's new session that is not saved
   * yet, and it stops when that process exits.
   */
  private async removeStale(): Promise<void> {
    const listed = await this.docker([
      'container', 'ls', '--all', '--filter', `label=${HOME_LABEL}=${this.home}`, '--format', `{{.Label "${SESSION_LABEL}"}} {{.State}}`,
    ])
    for (const line of listed.split('\n').filter(line => line !== '')) {
      const [label = '', state = ''] = line.split(' ')
      const id = label as SessionId
      if (this.archived.has(id) || (state !== 'running' && await this.ctx.sessionPersistence.stat(id) === undefined)) await this.remove(id)
    }
  }

  /**
   * Start the session's container, connect a helper in it, and attach the
   * world to its owner. The world's `ssh`, `fs` and `subprocess` live in their
   * own scope below this service, apart from the global `fs` and `subprocess`,
   * which route to them.
   *
   * The world is one effect of this service: cordis undoes its parts in
   * reverse, one at a time, whoever ends it. The world detaches from its
   * owner, the providers and then the helper close, and the container stops
   * last. That runs the same when the helper is lost, when the session is
   * archived, when dsh exits, and when the open fails halfway.
   */
  private async openWorld(root: SessionHeader, owner: Root): Promise<OpenWorld> {
    const container = await this.ensureContainer(root)
    const scope = this.ctx.isolate('ssh').isolate('fs').isolate('subprocess')
    const loads = [
      () => scope.plugin(DockerConnection, {
        docker: this.config.docker, container: container.name, workspace: container.workspace, tmp: container.tmp,
        node: HELPER_NODE, helper: HELPER_ENTRY, helperHash: this.helperHash,
        requestTimeoutMs: HELPER_REQUEST_TIMEOUT_MS, leaseMs: HELPER_LEASE_MS,
      }),
      () => scope.plugin(SshFileSystem),
      () => scope.plugin(SshSubprocessRuntime),
    ]
    const stopped = Promise.withResolvers<void>()
    const stop = (): Promise<void> => this.stop(container.name).catch((error: unknown) => {
      this.ctx.logger.warn(`fbox: could not stop ${container.name}: ${message(error)}`)
    }).finally(() => { stopped.resolve() })
    let opened: OpenWorld | undefined
    const detach = (): void => {
      if (opened !== undefined && owner.open === opened) owner.open = undefined
    }

    const fibers: Fiber[] = []
    let dispose: () => unknown
    try {
      // A synchronous generator: an async one would await each thenable fiber disposer it
      // yields, and cordis would not take them over.
      dispose = this.ctx.effect(function* () {
        yield stop
        for (const load of loads) {
          const fiber = load()
          fibers.push(fiber)
          yield fiber.dispose
        }
        yield detach
      }, `fbox world of ${container.name}`)
    } catch (error) {
      // This service is unloading; cordis undid whatever the effect had made.
      await stop()
      throw error
    }
    const close = (): Promise<void> => {
      Promise.resolve(dispose()).catch((error: unknown) => {
        this.ctx.logger.warn(`fbox: could not tear down the world of ${container.name}: ${message(error)}`)
      })
      return stopped.promise
    }

    try {
      for (const fiber of fibers) await fiber
      const connection = scope.get('ssh')
      const fs = scope.get('fs')
      const subprocess = scope.get('subprocess')
      if (!(connection instanceof DockerConnection) || fs === undefined || subprocess === undefined) {
        throw new Error(`fbox: the providers for ${container.name} did not start`)
      }
      const world: OpenWorld = { world: { container, fs, subprocess }, close }
      opened = world
      owner.open = world
      void connection.ended.then((error) => { this.lose(root.id, owner, world, error) })
      return world
    } catch (error) {
      await close()
      throw error
    }
  }

  /**
   * Detach a world whose helper ended without being asked to, so no call gets
   * it, and tear it down after the operations before it.
   */
  private lose(id: SessionId, owner: Root, opened: OpenWorld, error: Error): void {
    if (owner.open !== opened) return
    owner.open = undefined
    this.ctx.logger.warn(`fbox: lost the helper in ${opened.world.container.name}, which ends its running commands; `
      + `the container stops, and the next use starts it again: ${error.message}`)
    void this.enqueue(id, () => opened.close())
  }

  /** Create, recreate, or start the root session's container. */
  private async ensureContainer(root: SessionHeader): Promise<SessionContainer> {
    const workspace = root.cwd
    if (workspace === undefined || !isAbsolute(workspace)) {
      throw new Error(`fbox: session ${root.id} has no absolute folder to mount (cwd: ${String(workspace)})`)
    }
    // `--mount` parses comma-separated fields.
    if (/[,\n]/u.test(workspace)) throw new Error(`fbox: cannot mount a folder whose path contains a comma or newline: ${workspace}`)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(root.id)) throw new Error(`fbox: session id ${root.id} is not usable as a container name`)
    const name = containerName(root.id)
    const tmp = this.tmpFolder(root.id)
    await mkdir(tmp, { recursive: true, mode: 0o700 })

    const runArgs = [
      '--label', `${SESSION_LABEL}=${root.id}`, '--label', `${HOME_LABEL}=${this.home}`,
      '--init',
      '--mount', `type=bind,src=${workspace},dst=${workspace}`,
      '--mount', `type=bind,src=${tmp},dst=/tmp`,
      '--workdir', workspace,
      this.image, 'sleep', 'infinity',
    ]
    const spec = createHash('sha256').update(JSON.stringify(runArgs)).digest('hex').slice(0, 16)
    const existing = await this.inspect(name)
    if (existing?.spec === spec) {
      if (!existing.running) await this.docker(['start', name])
    } else {
      if (existing !== undefined) {
        this.ctx.logger.warn(`fbox: recreating ${name}; its image or mounts changed, so changes outside ${workspace} and /tmp are lost`)
        await this.docker(['rm', '--force', name])
      }
      await this.docker(['run', '--detach', '--name', name, '--label', `${SPEC_LABEL}=${spec}`, ...runArgs])
    }
    const created = existing?.spec === spec ? existing : await this.inspect(name)
    if (created === undefined) throw new Error(`fbox: ${name} disappeared right after it started`)
    return { name, id: created.id, created: created.created, workspace, tmp }
  }

  /** @returns the container's identity and state, or undefined when no such container exists. */
  private async inspect(name: string): Promise<{ id: string; created: number; running: boolean; spec: string } | undefined> {
    let state: string
    try {
      state = await this.docker(['container', 'inspect', '--format', `{{.Id}} {{.Created}} {{.State.Running}} {{index .Config.Labels "${SPEC_LABEL}"}}`, name])
    } catch (error) {
      if (error instanceof Error && /no such (object|container)/iu.test(error.message)) return undefined
      throw error
    }
    const [id = '', created = '', running = '', spec = ''] = state.split(' ')
    return { id, created: Date.parse(created), running: running === 'true', spec }
  }

  /** The host folder mounted at a session container's `/tmp`. */
  private tmpFolder(id: SessionId): string {
    return join(this.config.runtimeDir, createHash('sha256').update(id).digest('hex').slice(0, TMP_KEY_LENGTH))
  }

  /** Stop a container, which stays until its session is archived. */
  private async stop(name: string): Promise<void> {
    try {
      await this.docker(['stop', '--timeout', String(STOP_GRACE_SECONDS), name])
    } catch (error) {
      if (!isNoSuchContainer(error)) throw error
    }
  }

  /**
   * Run one Docker CLI command within the configured deadline.
   * @returns trimmed stdout; a failure carries Docker's stderr.
   */
  private docker(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.config.docker, args, { timeout: this.config.dockerTimeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error === null) resolve(stdout.trim())
        else reject(new Error(`fbox: docker ${args[0]} failed: ${stderr.trim() || error.message}`, { cause: error }))
      })
    })
  }
}

function containerName(id: SessionId): string {
  return `fbox-${id}`
}

function isNoSuchContainer(error: unknown): boolean {
  return error instanceof Error && /no such container/iu.test(error.message)
}

/** Stop waiting for an operation when the signal aborts; the operation goes on. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', aborted) })
  })
}

function archivedError(id: SessionId): Error {
  return new Error(`fbox: session ${id} is archived, and its container was removed`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default Fbox
