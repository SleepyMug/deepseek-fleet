/**
 * The runs of taus, and their boxes (docs/fleet-core/tau/index.md): it sets
 * up a box for a run, with the run's handles and the tau's own directory in
 * it (./place.ts), keeps which box each session has (./registry.ts), and
 * starts, stops and removes the box. It uses nothing of dsh's, so both
 * fleet-core's world (../world/), which serves a tau's session from its box,
 * and the tau service (./service.ts), which makes the session, build on it.
 * @module fleet-core/tau/runs
 */

import { randomUUID } from 'node:crypto'
import { readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { checkInputs, loadTau } from '@sleepymug/tau'
import type { Created, Values } from 'fleet-protocol/tau'
import { Box, exec } from '../box/box.ts'
import { FOLDERS, SELF, placer } from './place.ts'
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
  /** The sessions with a registry entry, as {@link load} found them and as they were made and removed since. */
  private readonly taus = new Set<string>()

  constructor(
    private readonly registry: Registry,
    private readonly log: (message: string) => void,
    private readonly docker: Boxes = dockerBoxes,
  ) {}

  /** Find the sessions the registry has, before anyone asks which sessions are a tau's. */
  async load(): Promise<void> {
    for (const sessionId of await this.registry.list()) this.taus.add(sessionId)
  }

  /**
   * Set up a box for a run of a tau, and leave it stopped: bind the values,
   * which checks them against the tau and expands its prompt; check the
   * handles' paths; then create the box, make its folders, the caller's
   * folder, where dsh will run the session's work, among them, copy in the
   * tau and each `$in` and `$inout` handle, and register the session. A
   * failure removes the box.
   * @param tauDir - the tau's directory, absolute.
   * @param values - the run's values, by parameter.
   * @param callerCwd - what relative paths in `values` are relative to, absolute.
   */
  async create(tauDir: string, values: Values, callerCwd: string): Promise<Created> {
    const tau = loadTau(tauDir)
    const run = tau.bind(values, { cwd: callerCwd }, placer(), SELF)
    checkInputs(run)
    const apis = await apiNames(tau.dir)
    const project = await realpath(callerCwd)
    const id = randomUUID()
    const sessionId = `session-${id}`
    const box = await this.docker.create(`fleet-tau-${id}`)
    try {
      await box.start()
      const outFolders = run.handles.filter(handle => handle.mode === 'out' && handle.kind === 'dir').map(handle => handle.view)
      await exec(box, ['mkdir', '-p', SELF, ...Object.values(FOLDERS), ...outFolders, project])
      await box.copyIn(tau.dir, SELF)
      for (const handle of run.handles) {
        if (handle.mode !== 'out') await box.copyIn(handle.host, handle.view)
      }
      await box.stop()
      this.taus.add(sessionId)
      await this.registry.put({
        sessionId,
        box: box.container,
        tauDir: tau.dir,
        project,
        prompt: run.prompt,
        promptRequestId: randomUUID(),
        handles: run.handles,
        apis,
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
   * The started box of a tau's session, for its files and processes
   * (../world/), started if it is not, as after a restart or a stop; or
   * undefined for a session that is not a tau's.
   */
  async boxFor(sessionId: string): Promise<RunBox | undefined> {
    if (!this.taus.has(sessionId)) return undefined
    return this.serial(sessionId, async () => {
      if (!this.taus.has(sessionId)) return undefined
      const box = await this.box(sessionId)
      if (!this.started.has(sessionId)) {
        await box.start()
        this.started.add(sessionId)
      }
      return box
    })
  }

  /** Start a session's box, and a new helper in it; a session that is not a tau's fails. */
  async start(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      await (await this.box(sessionId)).start()
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

  /** Run a session's operations on its box one after another. */
  private serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(sessionId) ?? Promise.resolve()).then(operation)
    const settled = next.then(() => {}, () => {})
    this.queues.set(sessionId, settled)
    void settled.then(() => { if (this.queues.get(sessionId) === settled) this.queues.delete(sessionId) })
    return next
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

/** The APIs a tau declares: the folders in its api/. */
async function apiNames(tauDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(tauDir, 'api'), { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
