/**
 * fleet-box, the fleet's container execution world (`ctx.fleetBox`). Every
 * root session owns one Docker container for as long as it is unarchived, and
 * one fleet-box helper inside it that serves the session's files and
 * processes to this bundle's `ctx.fs` and `ctx.subprocess`. The session
 * folder is bind-mounted at the same absolute path; everything else, `/tmp`
 * included, is the container's own. Processes run as the container's root,
 * which rootless Docker maps to the host user, so files in the workspace stay
 * the user's. Subagent sessions share their root's container; a fork is its
 * own root.
 *
 * Lifetime: a container runs exactly while this process has its session's
 * world open and its helper connected. A world opens before a model step
 * needs it, and its teardown always ends with the container stopped, whether
 * its helper was lost or dsh exits; the next use starts it again. Archiving a
 * session removes its container, and an unarchived session gets a fresh one
 * on its next use. Startup removes this dsh home's containers whose session
 * is archived, or gone and stopped. A container keeps running without a
 * helper only when dsh is killed, or exits before the teardown finishes; its
 * next use takes it over. The image is a prerequisite, built by
 * `fleet-setup image` from the fleet-setup package; without it this service
 * does not start, dsh's startup warning says how to build it, and no session
 * can run.
 * @module fleet-box/world
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import { HelperConnection } from './connection.ts'
import { HELPER_ENTRY, HELPER_NODE, imageTag } from './image.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetBox: FleetBox
  }
}

const SESSION_LABEL = 'fleet-box.session'
/** The dsh home a container's session belongs to; startup clean-up touches only its own home's containers. */
const HOME_LABEL = 'fleet-box.home'
/** Digest of a container's `docker run` arguments; a mismatch means the container is out of date. */
const SPEC_LABEL = 'fleet-box.spec'

/**
 * Grace `docker stop` gives the container's init. The helper has stopped
 * everything it started by then, leaving `sleep`, which exits on SIGTERM;
 * whatever escaped the helper is killed when the init exits, whatever the grace.
 */
const STOP_GRACE_SECONDS = 1

export interface Config {
  /** Docker CLI executable. */
  docker: string
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
}

/** One root session's container and the helper serving it. */
export interface SessionWorld {
  container: SessionContainer
  connection: HelperConnection
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

export class FleetBox extends Service {
  static inject = ['sessions', 'agents', 'workspaceRegistry', 'sessionPersistence']

  static Config: Schema<Config> = Schema.object({
    docker: Schema.string().default('docker').description('Docker CLI executable.'),
    dockerTimeoutMs: Schema.number().default(60_000).description('Deadline for one Docker CLI call.'),
  })

  private readonly config: Config
  /**
   * This service's own context. Another plugin that calls a method through
   * `ctx.fleetBox` makes `this.ctx` its own context, which would own the
   * worlds that call opens, so this service works through this one instead.
   */
  private readonly self: Context
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
  /**
   * Set once this instance is disposed. A config change restarts its fiber
   * with a new instance, and an open still in flight on this one must not
   * attach a world to the restarted fiber.
   */
  private closed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'fleetBox')
    this.config = config
    this.self = ctx
    this.archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
    this.started.promise.catch(() => {})
    ctx.effect(() => () => { this.closed = true }, 'fleet-box lifetime')

    // Every step opens its world first: a session unarchived while its agent stayed live gets a
    // fresh container, and a Docker failure fails the step rather than a tool call. A step in the
    // middle of a turn often sends no new messages yet still calls the model, so none is skipped.
    // A cancelled step stops waiting; the open goes on for the session's other agents. dsh's
    // archive gate rejects the steps of an archived session before they get here.
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
      this.image = await imageTag()
      try {
        await this.docker(['image', 'inspect', '--format', '{{.Id}}', this.image])
      } catch (error) {
        if (!/no such image/iu.test(message(error))) throw error
        throw new Error(`fleet-box: the session image ${this.image} is not built; build it with \`fleet-setup image\`, `
          + 'installed in this profile: `dsh plugin --profile <profile> exec fleet-setup image`')
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
   * @param signal - stops waiting; the open goes on for the session's other agents.
   * @returns the initiating agent and its root session's open world.
   */
  async current(operation: string, signal?: AbortSignal): Promise<{ agent: Agent; world: SessionWorld }> {
    const agent = this.agentOf(operation)
    return { agent, world: await this.forAgent(agent, signal) }
  }

  /**
   * The agent whose work the current call is, read synchronously so a
   * synchronous call can open that agent's world afterwards.
   * @param operation - the provider method, named in the error for a call outside any session.
   * @returns the initiating agent.
   */
  agentOf(operation: string): Agent {
    const agent = this.self.agents.currentInitiator()
    if (agent === undefined) throw new Error(`fleet-box: ${operation} was called outside a session; the container world serves only session work`)
    return agent
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
    if (this.closed) return Promise.reject(closedError())
    const open = this.roots.get(root.id)?.open
    if (open !== undefined && !this.archived.has(root.id)) return Promise.resolve(open.world)
    // Wait outside the queue, which startup's clean-up uses too.
    const opening = this.started.promise.then(() => this.enqueue(root.id, async (state) => {
      if (this.closed) throw closedError()
      if (this.archived.has(root.id)) throw archivedError(root.id)
      // The world serves the session and all its subagents, so it belongs to none of their agents.
      return (state.open ?? await this.self.agents.withoutInitiator(() => this.openWorld(root, state))).world
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

  /**
   * The root session whose container a session uses: subagent sessions walk
   * up to their parent, the same lineage the archive gate follows.
   */
  private rootHeader(header: SessionHeader): SessionHeader {
    const visited = new Set<SessionId>()
    let current = header
    while (current.origin === 'subagent' && current.parentSession !== undefined && !visited.has(current.id)) {
      visited.add(current.id)
      const parent = this.self.sessions.get(current.parentSession)
      if (parent === undefined) {
        throw new Error(`fleet-box: subagent session ${current.id} has parent ${current.parentSession}, which is not loaded, so its container is unknown`)
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
        this.self.logger.warn(`fleet-box: could not remove the container of archived session ${id}: ${message(error)}`)
      })
    }
  }

  /**
   * Remove a session's container; the workspace stays. The world's teardown
   * stops everything first. A subagent session owns no container, so its id
   * removes nothing.
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
    })
  }

  /**
   * Remove this dsh home's containers whose session is archived, or gone and
   * stopped: archived by a dsh process without this plugin, left by a crash
   * during a removal, or made for a new session that was never saved. A
   * running one may serve another dsh process's new session that is not saved
   * yet, and it stops when that process exits. One that cannot be removed,
   * such as one another dsh process is removing, is left for a later start.
   */
  private async removeStale(): Promise<void> {
    const listed = await this.docker([
      'container', 'ls', '--all', '--filter', `label=${HOME_LABEL}=${this.home}`, '--format', `{{.Label "${SESSION_LABEL}"}} {{.State}}`,
    ])
    for (const line of listed.split('\n').filter(line => line !== '')) {
      const [label = '', state = ''] = line.split(' ')
      const id = label as SessionId
      try {
        if (this.archived.has(id) || (state !== 'running' && await this.self.sessionPersistence.stat(id) === undefined)) await this.remove(id)
      } catch (error) {
        this.self.logger.warn(`fleet-box: could not remove the stale container ${containerName(id)}: ${message(error)}`)
      }
    }
  }

  /**
   * Start the session's container, connect a helper in it, and attach the
   * world to its owner.
   *
   * The world is one effect of this service, whichever plugin's call opened
   * it: cordis undoes its parts in reverse, one at a time, whoever ends it.
   * The world detaches from its owner, the helper stops what it started and
   * exits, and the container stops last. That runs the same when the helper
   * is lost, when the session is archived, when this service unloads, and
   * when the open fails halfway.
   */
  private async openWorld(root: SessionHeader, owner: Root): Promise<OpenWorld> {
    const container = await this.ensureContainer(root)
    const connection = new HelperConnection({
      docker: this.config.docker, container: container.name, workspace: container.workspace, node: HELPER_NODE, entry: HELPER_ENTRY,
    })
    const stopped = Promise.withResolvers<void>()
    const stop = (): Promise<void> => this.stop(container.name).catch((error: unknown) => {
      this.self.logger.warn(`fleet-box: could not stop ${container.name}: ${message(error)}`)
    }).finally(() => { stopped.resolve() })
    let opened: OpenWorld | undefined
    const detach = (): void => {
      if (opened !== undefined && owner.open === opened) owner.open = undefined
    }

    let dispose: () => unknown
    try {
      if (this.closed) throw closedError()
      dispose = this.self.effect(function* () {
        yield stop
        yield () => connection.close()
        yield detach
      }, `fleet-box world of ${container.name}`)
    } catch (error) {
      // This service is unloading or was unloaded, so nothing is attached; stop the container the open started.
      await stop()
      throw error
    }
    const close = (): Promise<void> => {
      Promise.resolve(dispose()).catch((error: unknown) => {
        this.self.logger.warn(`fleet-box: could not tear down the world of ${container.name}: ${message(error)}`)
      })
      return stopped.promise
    }

    try {
      await connection.start()
      const world: OpenWorld = { world: { container, connection }, close }
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
    this.self.logger.warn(`fleet-box: lost the helper in ${opened.world.container.name}, which ends its running commands; `
      + `the container stops, and the next use starts it again: ${error.message}`)
    void this.enqueue(id, () => opened.close())
  }

  /** Create, recreate, or start the root session's container. */
  private async ensureContainer(root: SessionHeader): Promise<SessionContainer> {
    const workspace = root.cwd
    if (workspace === undefined || !isAbsolute(workspace)) {
      throw new Error(`fleet-box: session ${root.id} has no absolute folder to mount (cwd: ${String(workspace)})`)
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(root.id)) throw new Error(`fleet-box: session id ${root.id} is not usable as a container name`)
    const name = containerName(root.id)

    const runArgs = [
      '--label', `${SESSION_LABEL}=${root.id}`, '--label', `${HOME_LABEL}=${this.home}`,
      '--init',
      '--mount', `type=bind,${mountField(`src=${workspace}`)},${mountField(`dst=${workspace}`)}`,
      '--workdir', workspace,
      this.image, 'sleep', 'infinity',
    ]
    const spec = createHash('sha256').update(JSON.stringify(runArgs)).digest('hex').slice(0, 16)
    const existing = await this.inspect(name)
    if (existing?.spec === spec) {
      if (!existing.running) await this.docker(['start', name])
    } else {
      if (existing !== undefined) {
        this.self.logger.warn(`fleet-box: recreating ${name}; its image or mounts changed, so changes outside ${workspace} are lost`)
        await this.docker(['rm', '--force', name])
      }
      await this.docker(['run', '--detach', '--name', name, '--label', `${SPEC_LABEL}=${spec}`, ...runArgs])
    }
    const created = existing?.spec === spec ? existing : await this.inspect(name)
    if (created === undefined) throw new Error(`fleet-box: ${name} disappeared right after it started`)
    return { name, id: created.id, created: created.created, workspace }
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
        else reject(new Error(`fleet-box: docker ${args[0]} failed: ${stderr.trim() || error.message}`, { cause: error }))
      })
    })
  }
}

function containerName(id: SessionId): string {
  return `fleet-box-${id}`
}

/** One field of a `--mount` value, which Docker parses as a CSV record; a plain path stays as it is, so its container's spec does too. */
function mountField(field: string): string {
  return /[",\r\n]/u.test(field) ? `"${field.replaceAll('"', '""')}"` : field
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

function closedError(): Error {
  return new Error('fleet-box: the container world was unloaded')
}

function archivedError(id: SessionId): Error {
  return new Error(`fleet-box: session ${id} is archived, and its container was removed`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default FleetBox
