/**
 * The tau service (docs/fleet-core/tau/index.md): it sets up a box for a run
 * of a tau, with the run's handles and the tau's own directory in it
 * (./place.ts), keeps which box each session has (./registry.ts), and
 * starts, stops and deletes the box. It creates no dsh session yet: `create`
 * mints the session's id and expands the prompt a session will be given.
 * @module fleet-core/tau/service
 */

import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { checkInputs, loadTau } from '@sleepymug/tau'
import type { Created, Values } from 'fleet-protocol/tau'
import { Box, exec } from '../box/box.ts'
import { FOLDERS, SELF, placer } from './place.ts'
import type { Registry } from './registry.ts'

/** What the service does with a box. */
export type ServiceBox = Pick<Box, 'container' | 'start' | 'stop' | 'remove' | 'copyIn' | 'request'>

/** Where the service gets its boxes: Docker's, through `Box`, unless a test stands in. */
export interface Boxes {
  create(name: string): Promise<ServiceBox>
  open(name: string): Promise<ServiceBox>
  /** Whether a box's container is there. */
  exists(name: string): Promise<boolean>
}

const dockerBoxes: Boxes = {
  create: name => Box.create({ name }),
  open: name => Box.open(name),
  exists: async name => (await Box.list()).some(box => box.name === name),
}

export class TauService {
  /** The box of each session the service has used, opened once, so that its verbs run in order. */
  private readonly boxes = new Map<string, Promise<ServiceBox>>()
  /** The sessions whose box the service started, which it stops when it closes. */
  private readonly started = new Set<string>()

  constructor(
    private readonly registry: Registry,
    private readonly log: (message: string) => void,
    private readonly docker: Boxes = dockerBoxes,
  ) {}

  /**
   * Set up a box for a run of a tau, and leave it stopped: bind the values,
   * which checks them against the tau and expands its prompt; check the
   * handles' paths; then create the box, make its folders, copy in the tau
   * and each `$in` and `$inout` handle, and register the session. A failure
   * removes the box.
   * @param tauDir - the tau's directory, absolute.
   * @param values - the run's values, by parameter.
   * @param callerCwd - what relative paths in `values` are relative to, absolute.
   */
  async create(tauDir: string, values: Values, callerCwd: string): Promise<Created> {
    const tau = loadTau(tauDir)
    const run = tau.bind(values, { cwd: callerCwd }, placer(), SELF)
    checkInputs(run)
    const apis = await apiNames(tau.dir)
    const id = randomUUID()
    const sessionId = `session-${id}`
    const box = await this.docker.create(`fleet-tau-${id}`)
    try {
      await box.start()
      const outFolders = run.handles.filter(handle => handle.mode === 'out' && handle.kind === 'dir').map(handle => handle.view)
      await exec(box, ['mkdir', '-p', SELF, ...Object.values(FOLDERS), ...outFolders])
      await box.copyIn(tau.dir, SELF)
      for (const handle of run.handles) {
        if (handle.mode !== 'out') await box.copyIn(handle.host, handle.view)
      }
      await box.stop()
      await this.registry.put({
        sessionId, box: box.container, tauDir: tau.dir, prompt: run.prompt, handles: run.handles, apis, createdAt: new Date().toISOString(),
      })
    } catch (error) {
      await box.remove().catch(() => {})
      throw error
    }
    this.boxes.set(sessionId, Promise.resolve(box))
    this.log(`created ${sessionId} in box ${box.container}, with the prompt:\n${run.prompt.trimEnd()}`)
    return { sessionId, box: box.container, prompt: run.prompt }
  }

  /** Start a session's box, and its helper. */
  async start(sessionId: string): Promise<void> {
    await (await this.box(sessionId)).start()
    this.started.add(sessionId)
  }

  /** Stop a session's box, which keeps what is in it. */
  async stop(sessionId: string): Promise<void> {
    await (await this.box(sessionId)).stop()
    this.started.delete(sessionId)
  }

  /** Remove a session's box, running or not, and forget the session. */
  async delete(sessionId: string): Promise<void> {
    const entry = await this.registry.get(sessionId)
    try {
      await (await this.box(sessionId)).remove()
    } catch (error) {
      // A box removed by other means leaves only the session to forget.
      if (await this.docker.exists(entry.box)) throw error
    }
    this.boxes.delete(sessionId)
    this.started.delete(sessionId)
    await this.registry.delete(sessionId)
    this.log(`deleted ${sessionId} and its box ${entry.box}`)
  }

  /** Stop the boxes the service started. */
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

  /** A session's box, opened the first time it is asked for. */
  private box(sessionId: string): Promise<ServiceBox> {
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
