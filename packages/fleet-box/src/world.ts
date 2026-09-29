/**
 * fleet-box, the fleet's container execution world (`ctx.fleetBox`). Every
 * root session owns one Docker container for as long as it is unarchived, and
 * one fleet-box helper inside it that serves the session's files and
 * processes to this bundle's `ctx.fs` and `ctx.subprocess`. The session
 * folder is bind-mounted at the same absolute path, beside any mounts another
 * plugin configured for the session (./additions.ts); everything else, `/tmp`
 * included, is the container's own, as are the host paths such a plugin has
 * copied in when the container was created (./copy-in.ts). Processes run as
 * the container's root, which rootless Docker maps to the host user, so files
 * in the workspace stay the user's. Subagent sessions share their root's container; a fork is its
 * own root.
 *
 * Lifetime: a container runs exactly while this process has its session's
 * world open and its helper connected. A world opens when something of its
 * session needs it: a model step, a process, a user's terminal, or a file
 * access, such as the file viewer's. It stays open while anything occupies
 * it (./occupancy.ts): a running turn of the session or its subagents, a
 * user's terminal, or a process, call or file access fleet-box serves there.
 * Once nothing does, it closes after `idleStopMs`, or at once when a caller
 * done with the session asks (`stopSession`); it never closes on its own
 * while occupied. Its teardown always ends with the container
 * stopped, whether it closed idle, its helper was lost, or dsh exits, and
 * everything still running in the container ends with it; the next use
 * starts it again. Archiving a session removes its container, and an
 * unarchived session gets a fresh one on its next use. Startup removes this
 * dsh home's containers whose session is archived, or gone and stopped. A
 * container keeps running without a helper only when dsh is killed, or exits
 * before the teardown finishes; its next use takes it over. The image, which
 * the `image` setting names, is a prerequisite built outside dsh by
 * `fleet-setup image` from the fleet-setup package (fleet-box-helper/image).
 * This service checks it when it starts, and creates every container from
 * the image it checked, so a rebuild reaches containers once dsh restarts,
 * and recreates them. Without the image, or with one whose helper speaks another
 * protocol, this service does not start, dsh's startup warning says how to
 * build it, and no session can run.
 * @module fleet-box/world
 */

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import { DEFAULT_IMAGE, HELPER_ENTRY, HELPER_NODE, PROTOCOL_LABEL } from 'fleet-box-helper/image'
import { PROTOCOL_VERSION, SERVICE_SOCKET } from 'fleet-box-helper/protocol'
import {
  additionArgs, mountField, readAdditions, readCopied, removeAdditions, writeAdditions, writeCopied, type ContainerAdditions, type Copy,
} from './additions.ts'
import { HelperConnection, type ServiceCallRequest } from './connection.ts'
import { copyIn } from './copy-in.ts'
import { copyOut as copyOutOf } from './copy-out.ts'
import { Occupancy, type Occupant } from './occupancy.ts'

export type { ContainerAdditions, Copy, Mount } from './additions.ts'
export type { ServiceCallRequest } from './calls.ts'

/**
 * Serves the service calls programs in a root session's container make
 * (fleet-box-helper's services.ts), for the session the container belongs to.
 * @param root - the root session whose container the call came from, as the connection knows it.
 * @param signal - aborts when the program goes away or the container's world ends.
 * @returns the call's result, JSON; a throw's message goes back to the program.
 */
export type ServiceHandler = (root: SessionId, call: ServiceCallRequest, signal: AbortSignal) => Promise<unknown>

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

/** Node's timer ceiling. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface Config {
  /** The session image, as `fleet-setup image` tags it. */
  image: string
  /** Docker CLI executable. */
  docker: string
  /** Deadline for one Docker CLI call. */
  dockerTimeoutMs: number
  /** How long a container keeps running once nothing occupies it. */
  idleStopMs: number
}

/** The session image as this service checked it at startup. */
interface CheckedImage {
  /** The image's id, which every container is created from. */
  id: string
  labels: Readonly<Record<string, string>>
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
  /** Docker CLI executable that drives the container. */
  docker: string
  /** Settles once this world's teardown has stopped the container, which ends everything in it. */
  stopped: Promise<void>
}

/** What {@link FleetBox.stopSession} did. */
export type StopOutcome =
  | { stopped: true }
  /** Something occupies the container, so it keeps running. */
  | { stopped: false; occupants: readonly Occupant[] }

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
  /** The pending idle stop; every vacancy re-arms it. */
  idle: NodeJS.Timeout | undefined
}

export class FleetBox extends Service {
  static inject = ['sessions', 'agents', 'workspaceRegistry', 'sessionPersistence']

  static Config: Schema<Config> = Schema.object({
    image: Schema.string().default(DEFAULT_IMAGE).description('The session image, as `fleet-setup image` tags it.'),
    docker: Schema.string().default('docker').description('Docker CLI executable.'),
    dockerTimeoutMs: Schema.number().default(60_000).description('Deadline for one Docker CLI call.'),
    idleStopMs: Schema.number().min(0).max(MAX_TIMER_DELAY_MS).default(60_000)
      .description('How long a container keeps running once nothing occupies it; 0 stops it as soon as it is vacant.'),
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
  private readonly occupancy: Occupancy
  /** Who serves the containers' service calls; every world's connection reads it for each call. */
  private readonly services: { handler: ServiceHandler | undefined } = { handler: undefined }
  /** Sessions archived in the workspace registry, as of its latest write. */
  private archived: ReadonlySet<SessionId>
  /**
   * Settles once the image is found and stale containers are removed. Agents
   * can be created before that, and their worlds wait for it, so none opens
   * without an image or is mistaken for stale before its session is saved.
   */
  private readonly started = Promise.withResolvers<void>()
  private image: CheckedImage = { id: '', labels: {} }
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
    this.occupancy = new Occupancy({
      agents: () => ctx.agents.list(),
      rootOf: (header) => {
        try {
          return this.rootHeader(header).id
        } catch {
          // Its lineage is not loaded, so it cannot occupy a container here.
          return undefined
        }
      },
      vacated: (id) => { this.vacated(id) },
    })
    this.started.promise.catch(() => {})
    ctx.effect(() => () => {
      this.closed = true
      for (const root of this.roots.values()) clearTimeout(root.idle)
    }, 'fleet-box lifetime')

    ctx.on('agent/status', ({ agent, status }) => { if (status !== 'running') this.occupancy.settled(agent) })
    ctx.on('agent/disposed', ({ agent }) => { this.occupancy.settled(agent) })

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

  /** Check the image and clean up before any session needs them; without the image or Docker, this service does not start. */
  async [Service.init](): Promise<void> {
    try {
      this.image = await this.checkImage()
      await this.removeStale()
      this.started.resolve()
    } catch (error) {
      this.started.reject(error)
      throw error
    }
  }

  /**
   * Look the configured image up, and check that its label says its helper
   * speaks this fleet-box's protocol; the helper's handshake checks it again
   * in each container.
   */
  private async checkImage(): Promise<CheckedImage> {
    const { image } = this.config
    let found: string
    try {
      // The whole config: Docker's template fails on a key an image's config leaves out.
      found = await this.docker(['image', 'inspect', '--format', '{{.Id}} {{json .Config}}', image])
    } catch (error) {
      if (!/no such image/iu.test(message(error))) throw error
      throw new Error(`fleet-box: the session image ${image} is not built; build it with \`fleet-setup image\` `
        + 'from the fleet checkout: `pnpm exec fleet-setup image`')
    }
    const space = found.indexOf(' ')
    const labels = (JSON.parse(found.slice(space + 1)) as { Labels?: Record<string, string> | null } | null)?.Labels ?? {}
    const protocol = labels[PROTOCOL_LABEL]
    if (protocol !== String(PROTOCOL_VERSION)) {
      throw new Error(`fleet-box: the helper in the session image ${image} speaks protocol ${protocol ?? 'unknown'}, not ${PROTOCOL_VERSION}; `
        + 'rebuild it with `fleet-setup image`')
    }
    return { id: found.slice(0, space), labels }
  }

  /**
   * The labels of the session image this service checked. `fleet-setup
   * image` labels it with the protocol of each part it installs, so a
   * plugin that runs its own part in a container checks its label here.
   */
  async imageLabels(): Promise<Readonly<Record<string, string>>> {
    await this.started.promise
    return this.image.labels
  }

  /**
   * The agent whose work the current call is, read synchronously so a
   * synchronous call can open that agent's world afterwards: the agent whose
   * turn made the call, or else the agent whose scoped context the caller
   * reached the provider through, as dsh's terminal controller reaches
   * `ctx.subprocess` through `agent.ctx`.
   * @param caller - the context the provider was reached through, its traced `this.ctx`.
   * @returns the agent, or undefined for a call that is no session's work.
   */
  sessionAgent(caller?: Context): Agent | undefined {
    return this.initiator() ?? (caller === undefined ? undefined : this.scopedAgent(caller))
  }

  /**
   * The agent whose work the current call is ({@link sessionAgent}), for a
   * call that serves only session work.
   * @param operation - the provider method, named in the error for a call outside any session.
   * @param caller - the context the provider was reached through, its traced `this.ctx`.
   * @returns the agent.
   */
  agentOf(operation: string, caller?: Context): Agent {
    const agent = this.sessionAgent(caller)
    if (agent === undefined) throw new Error(`fleet-box: ${operation} was called outside a session; the container world serves only session work`)
    return agent
  }

  /** The root session whose container an agent's work uses. */
  rootOf(agent: Agent): SessionId {
    return this.rootHeader(agent.session.header).id
  }

  /**
   * The root session whose container a session uses, for a session that
   * need not be loaded, such as one whose files the web client shows: each
   * header in its lineage comes from the loaded sessions or else from storage.
   * @param id - any session, a subagent's included.
   * @returns the header of its root session.
   * @throws when the session or one of its parents is not known.
   */
  async rootHeaderOf(id: SessionId): Promise<SessionHeader> {
    const visited = new Set<SessionId>()
    let current = await this.headerOf(id)
    while (current.origin === 'subagent' && current.parentSession !== undefined && !visited.has(current.id)) {
      visited.add(current.id)
      current = await this.headerOf(current.parentSession)
    }
    return current
  }

  /**
   * A session's header, for a session that need not be loaded: from the
   * loaded sessions or else from storage.
   * @returns the header, or undefined for a session not known.
   */
  async sessionHeader(id: SessionId): Promise<SessionHeader | undefined> {
    return this.self.sessions.get(id)?.header ?? (await this.self.sessionPersistence.stat(id))?.header
  }

  /**
   * Set what a root session's container gets beyond the session folder
   * (./additions.ts), before or after the session exists. The container gets
   * them from its next use on, which recreates it if it exists; a container
   * gets its copies when it is created.
   * @param root - a root session's id; a subagent shares its root's container.
   */
  async configure(root: SessionId, additions: ContainerAdditions): Promise<void> {
    if (!usableAsContainerName(root)) throw new Error(`fleet-box: session id ${root} is not usable as a container name`)
    await writeAdditions(this.home, root, additions)
  }

  /**
   * Copy a path out of a root session's container to a host path that does
   * not exist yet, as plain files and folders (./copy-out.ts), starting the
   * container if it is stopped; the copy occupies it while it runs.
   * @param root - a root session.
   * @param source - an absolute path in the container.
   * @param target - where the copy goes on the host.
   * @param maxBytes - the most the copy may hold.
   * @param signal - stops the copy, which leaves what it made so far.
   * @returns whether there was anything at `source` to copy.
   * @throws when something there is refused, or cannot be read.
   */
  async copyOut(root: SessionId, source: string, target: string, maxBytes: number, signal?: AbortSignal): Promise<boolean> {
    if (!source.startsWith('/') || !isAbsolute(target)) throw new Error('fleet-box: copying out takes absolute paths')
    const header = await this.rootHeaderOf(root)
    const release = this.occupy(header.id, { kind: 'file', id: randomUUID() })
    try {
      const world = await this.forRoot(header, signal)
      return await copyOutOf(world.connection, source, target, maxBytes, signal)
    } finally {
      release()
    }
  }

  /** Whether a turn of a root session, or of one of its subagents, runs now. */
  turnRunning(root: SessionId): boolean {
    return this.occupancy.of(root).some(occupant => occupant.kind === 'turn')
  }

  /** Remove what {@link configure} set for a root session, such as one that was never made. */
  async unconfigure(root: SessionId): Promise<void> {
    if (!usableAsContainerName(root)) throw new Error(`fleet-box: session id ${root} is not usable as a container name`)
    await removeAdditions(this.home, root)
  }

  /**
   * Serve every container's service calls, which fail until something does.
   * A call does not occupy its container: it comes from a program that a
   * turn or a terminal keeps running, and one that outlived them must not
   * keep the container running by calling.
   * @returns the removal, which leaves the calls unserved again.
   */
  serveCalls(handler: ServiceHandler): () => void {
    if (this.services.handler !== undefined) throw new Error('fleet-box: something already serves the containers\' service calls')
    this.services.handler = handler
    return () => { if (this.services.handler === handler) this.services.handler = undefined }
  }

  /**
   * Occupy a root session's container (./occupancy.ts). Call this before
   * asking for the world; a turn occupies it without this.
   * @returns the release, to call once nothing of the occupant can reach the container.
   */
  occupy(root: SessionId, occupant: Occupant): () => void {
    return this.occupancy.occupy(root, occupant)
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

  /**
   * Stop a root session's container now if nothing occupies it, as a caller
   * does once it is done with the session for now, instead of waiting for its
   * idle stop. The world is torn down as on exit and the container stays; the
   * next use starts it again. Only a container this process drives is
   * stopped: without a world here, one another dsh process drives, or a
   * killed dsh left running, is left alone.
   * @param id - a root session; a subagent session shares its root's container, so it is refused.
   * @returns whether no container of the session runs here, or what occupies it.
   */
  stopSession(id: SessionId): Promise<StopOutcome> {
    if (this.closed) return Promise.reject(closedError())
    if (this.self.sessions.get(id)?.header.origin === 'subagent') {
      return Promise.reject(new Error(`fleet-box: ${id} is a subagent session, which shares its root's container`))
    }
    // This process never opened the session's world.
    if (!this.roots.has(id)) return Promise.resolve({ stopped: true })
    return this.closeIfVacant(id)
  }

  /**
   * The voluntary close, for an idle stop or a caller done with the session:
   * in the root's queue, and only while nothing occupies the container.
   * Nothing awaits between the check and the detach, so an occupant that
   * appears later finds no open world and queues a fresh one behind this close.
   */
  private closeIfVacant(id: SessionId): Promise<StopOutcome> {
    return this.enqueue(id, async (state): Promise<StopOutcome> => {
      if (this.closed) throw closedError()
      if (state.open === undefined) return { stopped: true }
      const occupants = this.occupancy.of(id)
      if (occupants.length > 0) return { stopped: false, occupants }
      const opened = state.open
      state.open = undefined
      await opened.close()
      return { stopped: true }
    })
  }

  /**
   * A root session's container may have lost its last occupant: look again
   * after the idle grace, and stop it if it is still vacant then.
   */
  private vacated(id: SessionId): void {
    const root = this.roots.get(id)
    if (this.closed || root?.open === undefined) return
    clearTimeout(root.idle)
    root.idle = setTimeout(() => {
      root.idle = undefined
      if (this.closed) return
      this.closeIfVacant(id).catch((error: unknown) => {
        this.self.logger.warn(`fleet-box: could not stop the idle container of ${id}: ${message(error)}`)
      })
    }, this.config.idleStopMs)
    root.idle.unref()
  }

  /** Run one container operation of a root session after the ones before it. */
  private enqueue<T>(id: SessionId, operation: (root: Root) => Promise<T>): Promise<T> {
    let root = this.roots.get(id)
    if (root === undefined) {
      root = { queue: Promise.resolve(), open: undefined, idle: undefined }
      this.roots.set(id, root)
    }
    const state = root
    const result = state.queue.then(() => operation(state))
    state.queue = result.catch(() => {})
    return result
  }

  /** The agent whose turn the current call belongs to, or undefined outside any turn. */
  private initiator(): Agent | undefined {
    return this.self.agents.currentInitiator()
  }

  /** A session's header, loaded or else stored. */
  private async headerOf(id: SessionId): Promise<SessionHeader> {
    const header = await this.sessionHeader(id)
    if (header === undefined) throw new Error(`fleet-box: session ${id} is not known, so neither is its container`)
    return header
  }

  /** The live agent a context is scoped to (@deepseek-ai/dsh-scope), if any. */
  private scopedAgent(caller: Context): Agent | undefined {
    const key = scopeOf(caller)
    if (typeof key !== 'object' || key === null || !('id' in key)) return undefined
    const agent = this.self.agents.get((key as Agent).id)
    return agent === key ? agent : undefined
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
    const { container, directories, copies } = await this.ensureContainer(root)
    const connection = new HelperConnection({
      docker: this.config.docker, container: container.name, workspace: container.workspace, node: HELPER_NODE, entry: HELPER_ENTRY,
    })
    const services = this.services
    connection.serveCalls((call, signal) => {
      const handler = services.handler
      return handler === undefined ? Promise.reject(new Error('no services are provided here')) : handler(root.id, call, signal)
    })
    const stopped = Promise.withResolvers<void>()
    const stop = (): Promise<void> => this.stopContainer(container.name).catch((error: unknown) => {
      this.self.logger.warn(`fleet-box: could not stop ${container.name}: ${message(error)}`)
    }).finally(() => { stopped.resolve() })
    let opened: OpenWorld | undefined
    const detach = (): void => {
      // A newer world opens only after this teardown, in the root's queue, so the pending idle stop is this one's.
      clearTimeout(owner.idle)
      owner.idle = undefined
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
      if (directories.length > 0) await this.docker(['exec', container.name, 'mkdir', '-p', '--', ...directories])
      await connection.start()
      // Once per container, before anything uses it; a copy cut short is made again on the next open.
      if (copies.length > 0 && await readCopied(this.home, root.id) !== container.id) {
        for (const { source, target } of copies) await copyIn(connection, source, target)
        await writeCopied(this.home, root.id, container.id)
      }
      const world: OpenWorld = { world: { container, connection, docker: this.config.docker, stopped: stopped.promise }, close }
      opened = world
      owner.open = world
      void connection.ended.then((error) => { this.lose(root.id, owner, world, error) })
      // Whatever opened it may have ended while it opened, and its vacancy found no world then.
      this.vacated(root.id)
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

  /**
   * Create, recreate, or start the root session's container. Its spec is its
   * `docker run` arguments and its copies, so a change to either recreates it.
   * @returns the container, and the folders and copies its additions ask for.
   */
  private async ensureContainer(root: SessionHeader): Promise<{ container: SessionContainer; directories: string[]; copies: Copy[] }> {
    const workspace = root.cwd
    if (workspace === undefined || !isAbsolute(workspace)) {
      throw new Error(`fleet-box: session ${root.id} has no absolute folder to mount (cwd: ${String(workspace)})`)
    }
    if (!usableAsContainerName(root.id)) throw new Error(`fleet-box: session id ${root.id} is not usable as a container name`)
    const name = containerName(root.id)

    const additions = await readAdditions(this.home, root.id)
    const runArgs = [
      '--label', `${SESSION_LABEL}=${root.id}`, '--label', `${HOME_LABEL}=${this.home}`,
      '--init',
      '--mount', `type=bind,${mountField(`src=${workspace}`)},${mountField(`dst=${workspace}`)}`,
      // Every process in the container finds the service socket, as tau's runtimes look for it.
      '--env', `TAU_SOCKET=${SERVICE_SOCKET}`,
      ...additionArgs(additions, workspace),
      '--workdir', workspace,
      // By id: the image checked at startup, which a rebuild under the same tag replaces in the spec.
      this.image.id, 'sleep', 'infinity',
    ]
    const copies = additions?.copies ?? []
    // Without copies, the spec is what it was before containers had any.
    const spec = createHash('sha256').update(JSON.stringify(runArgs)).update(copies.length === 0 ? '' : JSON.stringify(copies)).digest('hex').slice(0, 16)
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
    return { container: { name, id: created.id, created: created.created, workspace }, directories: additions?.directories ?? [], copies }
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
  private async stopContainer(name: string): Promise<void> {
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

/** Whether a root session's id can name its container, as Docker allows container names. */
export function usableAsContainerName(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(id)
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
