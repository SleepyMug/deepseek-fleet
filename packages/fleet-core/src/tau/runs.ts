/**
 * The runs of taus, and their boxes (docs/fleet-core/tau/index.md): it sets
 * up a box for a run, with the run's handles and the tau's own directory in
 * it (./place.ts), and its APIs linked to the clients of the extensions that
 * implement them (./apis.ts); keeps which box each session has
 * (./registry.ts); starts, stops and removes the box, and copies host files
 * into it as they are asked for; and answers the calls the clients in the
 * box make, with the extensions' servers. It uses nothing of dsh's, so both
 * fleet-core's world (../world/), which serves a tau's session from its box,
 * and the tau service (./service.ts), which makes the session, build on it.
 * @module fleet-core/tau/runs
 */

import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { posix, relative, sep } from 'node:path'
import { checkInputs, loadTau } from '@sleepymug/tau'
import type { Call } from 'fleet-image/helper/protocol'
import type { Created, Values } from 'fleet-protocol/tau'
import { Box, exec } from '../box/box.ts'
import { linkApis, type Exts } from './apis.ts'
import { CLIENTS, FOLDERS, MODULES, SELF, placer } from './place.ts'
import type { Entry, Registry } from './registry.ts'

/** What a run's box is used for. */
export type RunBox = Pick<Box, 'container' | 'start' | 'stop' | 'remove' | 'copyIn' | 'request'>

/** Where the runs get their boxes: Docker's, through `Box`, unless a test stands in. */
export interface Boxes {
  create(name: string): Promise<RunBox>
  open(name: string): Promise<RunBox>
  /** Whether a box's container is there. */
  exists(name: string): Promise<boolean>
}

const dockerBoxes: Boxes = {
  create: name => Box.create({ name }),
  open: name => Box.open(name),
  exists: async name => (await Box.list()).some(box => box.name === name),
}

export class TauRuns {
  /** The box of each session used, opened once, so that its verbs run in order. */
  private readonly boxes = new Map<string, Promise<RunBox>>()
  /** The sessions whose box was started here, which {@link close} stops. */
  private readonly started = new Set<string>()
  /** Each session's last operation on its box, which its next one waits for. */
  private readonly queues = new Map<string, Promise<void>>()
  /**
   * The sessions with a registry entry, each with its project, as {@link load}
   * found them and as they were made and removed since.
   */
  private readonly taus = new Map<string, string>()
  /** Each session's host files copied into its box, or on their way, by their place there. */
  private readonly copies = new Map<string, Map<string, Promise<void>>>()

  constructor(
    private readonly registry: Registry,
    private readonly exts: Exts,
    private readonly log: (message: string) => void,
    private readonly docker: Boxes = dockerBoxes,
  ) {}

  /** Find the sessions the registry has, before anyone asks which sessions are a tau's. */
  async load(): Promise<void> {
    for (const sessionId of await this.registry.list()) this.taus.set(sessionId, (await this.registry.get(sessionId)).project)
  }

  /**
   * Set up a box for a run of a tau, and leave it stopped: bind the values,
   * which checks them against the tau and expands its prompt; check the
   * handles' paths; link the tau's APIs to the extensions provided; then
   * create the box, make its folders, copy in the tau, each `$in` and
   * `$inout` handle, and each API's client, link the APIs and what the tau
   * exposes, and register the session. A failure removes the box.
   * @param tauDir - the tau's directory, absolute.
   * @param values - the run's values, by parameter.
   * @param callerCwd - what relative paths in `values` are relative to, absolute.
   */
  async create(tauDir: string, values: Values, callerCwd: string): Promise<Created> {
    const tau = loadTau(tauDir)
    const run = tau.bind(values, { cwd: callerCwd }, placer(), SELF)
    checkInputs(run)
    const linked = linkApis(tau, this.exts)
    const tauRoot = await realpath(tau.dir)
    const project = await realpath(callerCwd)
    const id = randomUUID()
    const sessionId = `session-${id}`
    const box = await this.docker.create(`fleet-tau-${id}`)
    try {
      await box.start()
      const outFolders = run.handles.filter(handle => handle.mode === 'out' && handle.kind === 'dir').map(handle => handle.view)
      await exec(box, ['mkdir', '-p', SELF, ...Object.values(FOLDERS), ...outFolders, CLIENTS])
      await box.copyIn(tau.dir, SELF)
      for (const handle of run.handles) {
        if (handle.mode !== 'out') await box.copyIn(handle.host, handle.view)
      }
      for (const api of linked.apis) await box.copyIn(api.client, `${CLIENTS}/${api.name}`)
      await box.request('apis.link', {
        modules: MODULES,
        apis: linked.apis.map(({ name }) => ({ name, client: `${CLIENTS}/${name}`, types: `${SELF}/api/${name}` })),
        packages: linked.packages.map(({ name, dir }) => ({ name, dir: posix.join(SELF, ...relative(tauRoot, dir).split(sep)) })),
      })
      await box.stop()
      this.taus.set(sessionId, project)
      await this.registry.put({
        sessionId,
        box: box.container,
        tauDir: tau.dir,
        project,
        prompt: run.prompt,
        promptRequestId: randomUUID(),
        handles: run.handles,
        apis: linked.apis.map(api => api.name),
        exposed: linked.exposed,
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      this.taus.delete(sessionId)
      await box.remove().catch(() => {})
      throw error
    }
    this.boxes.set(sessionId, Promise.resolve(box))
    this.log(`created ${sessionId} in box ${box.container}, with the prompt:\n${run.prompt.trimEnd()}`)
    return { sessionId, box: box.container, prompt: run.prompt }
  }

  /** A session's registry entry; a session that is not a tau's fails. */
  entry(sessionId: string): Promise<Entry> {
    return this.registry.get(sessionId)
  }

  /** Record that a session was given its prompt. */
  async prompted(sessionId: string): Promise<void> {
    await this.registry.put({ ...await this.registry.get(sessionId), promptedAt: new Date().toISOString() })
  }

  /** Whether a session is a tau's, at once, so that a caller that cannot wait, such as a process's start, can ask. */
  isTau(sessionId: string): boolean {
    return this.taus.has(sessionId)
  }

  /**
   * Where a path of a tau's session's work is in its box. dsh runs the
   * session's work in its project, the caller's folder, which is
   * {@link FOLDERS}.inout, /tau/workspace, in the box; a path in the project
   * is there too, and any other path is as it is. A session that is not a
   * tau's keeps its paths.
   */
  boxPath(sessionId: string, path: string): string {
    const project = this.taus.get(sessionId)
    if (project === undefined) return path
    if (path === project) return FOLDERS.inout
    return path.startsWith(`${project}/`) ? `${FOLDERS.inout}${path.slice(project.length)}` : path
  }

  /**
   * The started box of a tau's session, for its files and processes
   * (../world/), started if it is not, as after a restart or a stop; or
   * undefined for a session that is not a tau's.
   */
  async boxFor(sessionId: string): Promise<RunBox | undefined> {
    if (!this.taus.has(sessionId)) return undefined
    return this.serial(sessionId, async () => this.taus.has(sessionId) ? this.running(sessionId) : undefined)
  }

  /**
   * Copy a host file into the box of a tau's session, at `to`, readable by
   * all and writable by none, once: asked again for the same place, it does
   * nothing, unless the copy failed, which it prints. It answers at once, and
   * copies in turn with the session's other operations on its box, so a
   * {@link boxFor} asked after it waits for the copy. A session that is not a
   * tau's is ignored.
   * @param from - the host file, absolute.
   * @param to - its place in the box, absolute.
   */
  copyInOnce(sessionId: string, from: string, to: string): void {
    if (!this.taus.has(sessionId)) return
    let copies = this.copies.get(sessionId)
    if (copies === undefined) this.copies.set(sessionId, copies = new Map())
    if (copies.has(to)) return
    const copying = this.serial(sessionId, async () => {
      if (!this.taus.has(sessionId)) return
      const box = await this.running(sessionId)
      await exec(box, ['mkdir', '-p', posix.dirname(to)])
      await box.copyIn(from, to)
      await exec(box, ['chmod', 'a=r', to])
    })
    copies.set(to, copying)
    copying.catch((error: unknown) => {
      if (this.copies.get(sessionId)?.get(to) === copying) this.copies.get(sessionId)?.delete(to)
      this.log(`could not copy ${from} into the box of ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Start a session's box, and a new helper in it; a session that is not a tau's fails. */
  async start(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      await (await this.box(sessionId)).start(this.calls(sessionId))
      this.started.add(sessionId)
    })
  }

  /** Stop a session's box, which keeps what is in it. */
  async stop(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      await (await this.box(sessionId)).stop()
      this.started.delete(sessionId)
    })
  }

  /** Remove a session's box, running or not, and its registry entry. A box removed by other means leaves only the entry. */
  async remove(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      const entry = await this.registry.get(sessionId)
      try {
        await (await this.box(sessionId)).remove()
      } catch (error) {
        if (await this.docker.exists(entry.box)) throw error
      }
      this.boxes.delete(sessionId)
      this.started.delete(sessionId)
      this.copies.delete(sessionId)
      await this.registry.delete(sessionId)
      this.taus.delete(sessionId)
    })
  }

  /** Stop the boxes started here. */
  async close(): Promise<void> {
    const started = [...this.started]
    this.started.clear()
    await Promise.all(started.map(async (sessionId) => {
      try {
        await (await this.box(sessionId)).stop()
      } catch (error) {
        this.log(`could not stop the box of ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))
  }

  /**
   * What answers the calls of the clients in a session's box: the server of
   * the extension that implements the API, for an API the session's tau
   * declares, with the session the box is, whatever the call says.
   */
  private calls(sessionId: string): (call: Call, signal: AbortSignal) => Promise<unknown> {
    return async ({ api, method, args }, signal) => {
      const entry = await this.registry.get(sessionId)
      if (!entry.apis.includes(api)) throw new Error(`fleet: this run's tau declares no API ${api}`)
      const ext = this.exts.get(api)
      if (ext === undefined) throw new Error(`fleet: no extension implements ${api} now`)
      if (!Object.hasOwn(ext.methods, method)) throw new Error(`fleet: the extension of ${api} has no method ${method}`)
      return await ext.methods[method]?.(args, { sessionId, signal })
    }
  }

  /** Run a session's operations on its box one after another. */
  private serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(sessionId) ?? Promise.resolve()).then(operation)
    const settled = next.then(() => {}, () => {})
    this.queues.set(sessionId, settled)
    void settled.then(() => { if (this.queues.get(sessionId) === settled) this.queues.delete(sessionId) })
    return next
  }

  /** A session's box, started if it was not started here, in one of its operations. */
  private async running(sessionId: string): Promise<RunBox> {
    const box = await this.box(sessionId)
    if (!this.started.has(sessionId)) {
      await box.start(this.calls(sessionId))
      this.started.add(sessionId)
    }
    return box
  }

  /** A session's box, opened the first time it is asked for. */
  private box(sessionId: string): Promise<RunBox> {
    const known = this.boxes.get(sessionId)
    if (known !== undefined) return known
    const opening = this.registry.get(sessionId).then(entry => this.docker.open(entry.box))
    this.boxes.set(sessionId, opening)
    // One that would not open is opened again the next time.
    opening.catch(() => { if (this.boxes.get(sessionId) === opening) this.boxes.delete(sessionId) })
    return opening
  }
}
