/**
 * fleet-tau's store of session specs (`ctx.fleetTau`). The `fleet` command
 * runs an agent directory in the tau format as a session of the fleet host:
 * fleet-control has the directory read here, off the host's thread
 * (./prepare.ts), then stores what the session needs before the session
 * exists, so nothing of the session ever runs without it. A session's folder
 * in the store, `$DSH_HOME/fleet/sessions/<id>/`, holds `spec.json`
 * (./spec.ts) and `agent/`, a snapshot of the agent's PROMPT.md, tau.json,
 * skills and service manifests, with symlinks followed, which the session's container sees
 * read-only at {@link AGENT_VIEW} through fleet-box's container additions.
 * fleet-tau's agent plugin (./agent.ts) gives the session's agents what the
 * spec holds, whenever an agent is created or resumed.
 *
 * A fork of such a session has no folder of its own: it takes its source's
 * spec, and its container the same snapshot.
 * @module fleet-tau/store
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ContainerAdditions } from 'fleet-box/world'
import type { Prepared, PrepareRequest } from './prepare.ts'
import type {} from './services.ts'
import { AGENT_VIEW, specSchema, type Spec } from './spec.ts'
import type { Answer, Job } from './worker.ts'

export type { Prepared, PrepareRequest } from './prepare.ts'
export type { Skill, Spec } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetTau: FleetTau
  }
}

/** What of an agent directory the snapshot keeps. */
const AGENT_PARTS = ['PROMPT.md', 'tau.json', 'skills', 'services']

/** A session's spec, and the session whose folder holds it, which for a fork is its source. */
export interface Found {
  spec: Spec
  /** The session whose store folder holds the spec: the session itself, or a fork's source. */
  owner: SessionId
}

export class FleetTau extends Service {
  static inject = ['fleetBox', 'fleetServices']

  private readonly home = resolveDshHome()
  /** This service's own context, whichever plugin calls it. */
  private readonly self: Context
  private worker: Worker | undefined
  private readonly jobs = new Map<number, PromiseWithResolvers<Prepared>>()
  private nextJob = 1
  /** Specs by session, read once; a failed read is tried again. */
  private readonly specs = new Map<SessionId, Promise<Found | undefined>>()

  constructor(ctx: Context) {
    super(ctx, 'fleetTau')
    this.self = ctx
    ctx.effect(() => () => {
      const worker = this.worker
      this.worker = undefined
      this.fail(new Error('fleet-tau: the store was unloaded'))
      void worker?.terminate()
    }, 'fleet-tau worker')
  }

  /**
   * Read an agent directory for a run or a check, in a worker, its services
   * checked against those provided now.
   * @returns the session's spec and title, or every problem found.
   */
  prepare(request: Omit<PrepareRequest, 'providers'>): Promise<Prepared> {
    const job = Promise.withResolvers<Prepared>()
    const id = this.nextJob++
    this.jobs.set(id, job)
    const worker = this.startWorker()
    // Held only while it has work, so an idle worker never keeps a process alive.
    worker.ref()
    worker.postMessage({ id, request: { ...request, providers: this.self.fleetServices.list() } } satisfies Job)
    return job.promise
  }

  /**
   * Store a session's spec before the session exists: its folder, then its
   * container's additions. A failure leaves nothing behind.
   * @param session - the id the session will have.
   */
  async create(session: SessionId, spec: Spec): Promise<void> {
    const folder = this.folder(session)
    await mkdir(join(this.home, 'fleet', 'sessions'), { recursive: true, mode: 0o700 })
    // Fails if the folder exists, so a spec is never mixed with another's.
    await mkdir(folder, { mode: 0o700 })
    try {
      for (const part of AGENT_PARTS) {
        await cp(join(spec.agent.source, part), join(folder, 'agent', part), { recursive: true, dereference: true, force: false, errorOnExist: true })
          .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      }
      await writeFile(join(folder, 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600 })
      await this.self.fleetBox.configure(session, this.additions(session))
    } catch (error) {
      await this.remove(session)
      throw error
    }
  }

  /** Remove a session's spec and its container's additions, for a session that was never made. */
  async remove(session: SessionId): Promise<void> {
    this.specs.delete(session)
    await rm(this.folder(session), { recursive: true, force: true })
    await this.self.fleetBox.unconfigure(session)
  }

  /**
   * A root session's spec: its own, or else, for a fork, its source's.
   * @param root - the header of a session that is not a subagent.
   * @returns the spec, or undefined for a session the `fleet` command did not start from an agent directory.
   * @throws when a stored spec cannot be read.
   */
  specOf(root: SessionHeader): Promise<Found | undefined> {
    let found = this.specs.get(root.id)
    if (found === undefined) {
      found = this.find(root)
      this.specs.set(root.id, found)
      found.catch(() => { if (this.specs.get(root.id) === found) this.specs.delete(root.id) })
    }
    return found
  }

  /** A fork's container additions: its source's snapshot, since a fork has no folder of its own. */
  async configureFork(fork: SessionId, found: Found): Promise<void> {
    await this.self.fleetBox.configure(fork, this.additions(found.owner))
  }

  private additions(owner: SessionId): ContainerAdditions {
    return { mounts: [{ source: join(this.folder(owner), 'agent'), target: AGENT_VIEW, readonly: true }] }
  }

  private async find(root: SessionHeader): Promise<Found | undefined> {
    const spec = await this.read(root.id)
    if (spec !== undefined) return { spec, owner: root.id }
    // A fork is a root of its own whose parent is the session it was forked from.
    if (root.origin === 'subagent' || root.parentSession === undefined) return undefined
    return this.specOf(await this.self.fleetBox.rootHeaderOf(root.parentSession))
  }

  private async read(session: SessionId): Promise<Spec | undefined> {
    const file = join(this.folder(session), 'spec.json')
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      return specSchema.parse(JSON.parse(text))
    } catch (error) {
      throw new Error(`fleet-tau: the spec of ${session} in ${file} is not valid: ${message(error)}`, { cause: error })
    }
  }

  private folder(session: SessionId): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(session)) throw new Error(`fleet-tau: ${session} is not a session id the store can hold`)
    return join(this.home, 'fleet', 'sessions', session)
  }

  private startWorker(): Worker {
    if (this.worker !== undefined) return this.worker
    const worker = new Worker(new URL('./worker.js', import.meta.url))
    worker.on('message', (answer: Answer) => {
      const job = this.jobs.get(answer.id)
      if (job === undefined) return
      this.jobs.delete(answer.id)
      if (this.jobs.size === 0) worker.unref()
      if ('error' in answer) job.reject(new Error(`fleet-tau: could not read the agent directory: ${answer.error}`))
      else job.resolve(answer.result)
    })
    // A worker that fails ends every job it holds; the next job starts a new one.
    const lost = (error: Error): void => {
      if (this.worker !== worker) return
      this.worker = undefined
      this.fail(error)
    }
    worker.on('error', lost)
    worker.on('exit', (code) => { lost(new Error(`fleet-tau: the worker reading agent directories exited (${code})`)) })
    this.worker = worker
    return worker
  }

  private fail(error: Error): void {
    for (const job of this.jobs.values()) job.reject(error)
    this.jobs.clear()
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default FleetTau
