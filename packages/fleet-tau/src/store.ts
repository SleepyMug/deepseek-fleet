/**
 * fleet-tau's store of session specs (`ctx.fleetTau`). The `fleet` command
 * runs an agent directory in the tau format as a session of the fleet host:
 * fleet-control has the directory read here, off the host's thread
 * (./prepare.ts), then stores what the session needs before the session
 * exists, so nothing of the session ever runs without it. A session's folder
 * in the store, `$DSH_HOME/fleet/sessions/<id>/`, holds `spec.json`
 * (./spec.ts) and `agent/`, a snapshot of the agent's PROMPT.md, tau.json,
 * skills, service manifests and modules, with symlinks followed, which the session's container sees
 * read-only at {@link AGENT_VIEW} through fleet-box's container additions.
 * fleet-tau's agent plugin (./agent.ts) gives the session's agents what the
 * spec holds, whenever an agent is created or resumed.
 *
 * The container gets the agent's path arguments too: a `mount-ro` or
 * `mount-rw` path mounted from the caller, a `copy-in` path mounted from a
 * copy taken into the session's folder when the session is made, and the
 * folder a `copy-out` path goes in; and the caller's values of the variables
 * tau.json lists. After a completed turn, the command that waited on it has
 * the store publish the `copy-out` paths ({@link FleetTau.publish}).
 *
 * A fork of such a session has no folder of its own: it takes its source's
 * spec, and its container the same snapshot, but none of its paths or
 * variables, which belong to the run that started the source.
 * @module fleet-tau/store
 */

import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ContainerAdditions, Mount } from 'fleet-box/world'
import { MAX_OUTPUT_BYTES, copyProblems, outputProblems, replace } from './outputs.ts'
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
const AGENT_PARTS = ['PROMPT.md', 'tau.json', 'skills', 'services', 'modules']
/** How long copying a turn's outputs out of the container may take. */
const PUBLISH_TIMEOUT_MS = 10 * 60_000
const BUSY = 'the session started another turn before its outputs were copied, so they were not published; `fleet wait` publishes them once it is idle'

/** A job the worker has not answered yet. */
interface PendingJob {
  request: PrepareRequest
  result: PromiseWithResolvers<Prepared>
  timer: NodeJS.Timeout
}

/** A session's spec, and the session whose folder holds it, which for a fork is its source. */
export interface Found {
  spec: Spec
  /** The session whose store folder holds the spec: the session itself, or a fork's source. */
  owner: SessionId
}

export interface Config {
  /** How long reading an agent directory may take before the worker is replaced. */
  prepareTimeoutMs: number
}

export class FleetTau extends Service {
  static inject = ['fleetBox', 'fleetServices']

  static Config: Schema<Config> = Schema.object({
    prepareTimeoutMs: Schema.number().min(1).default(120_000).description('How long reading an agent directory may take before the worker is replaced.'),
  })

  private readonly home = resolveDshHome()
  /** This service's own context, whichever plugin calls it. */
  private readonly self: Context
  private worker: Worker | undefined
  private readonly jobs = new Map<number, PendingJob>()
  private nextJob = 1
  /** Each session's latest publish, which the next one waits for. */
  private readonly publishing = new Map<SessionId, Promise<unknown>>()
  /** Specs by session, read once; a failed read is tried again. */
  private readonly specs = new Map<SessionId, Promise<Found | undefined>>()

  constructor(ctx: Context, private readonly config: Config) {
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
    const result = Promise.withResolvers<Prepared>()
    const id = this.nextJob++
    const timer = setTimeout(() => { this.timedOut(id) }, this.config.prepareTimeoutMs)
    timer.unref()
    this.jobs.set(id, { request: { ...request, providers: this.self.fleetServices.list() }, result, timer })
    this.post(id)
    return result.promise
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
      // A prompt run has no agent, and its container sees an empty snapshot.
      await mkdir(join(folder, 'agent'), { mode: 0o700 })
      for (const path of spec.paths.filter(path => path.mode === 'copy-in')) {
        await cp(path.host, join(folder, 'paths', path.name), { recursive: true, dereference: true, errorOnExist: true, force: false })
      }
      if (spec.agent !== undefined) {
        for (const part of AGENT_PARTS) {
          await cp(join(spec.agent.source, part), join(folder, 'agent', part), { recursive: true, dereference: true, force: false, errorOnExist: true })
            .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
        }
      }
      await writeFile(join(folder, 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600 })
      await this.self.fleetBox.configure(session, this.additions(session, spec))
    } catch (error) {
      await this.remove(session)
      throw error
    }
  }

  /**
   * Publish a session's `copy-out` paths after a completed turn, once per
   * turn: copy each out of the container into a staging folder of this
   * publish's own, check the copies (./outputs.ts) and that the run left
   * what the tau declares, and only then replace the caller's paths. A
   * session's publishes run one at a time, so two commands waiting on it
   * never copy over each other, and none happens while a turn runs, since
   * the agent could be changing what is copied. A fork publishes nothing;
   * its source's paths belong to the source's run.
   * @param turn - the turn's place in the session's log.
   * @returns the problems that kept the outputs from being published, none when they were, or there was nothing to publish.
   */
  publish(session: SessionId, turn: number): Promise<string[]> {
    const next = (this.publishing.get(session) ?? Promise.resolve()).catch(() => {}).then(() => this.publishOnce(session, turn))
    this.publishing.set(session, next)
    void next.catch(() => {}).finally(() => { if (this.publishing.get(session) === next) this.publishing.delete(session) })
    return next
  }

  private async publishOnce(session: SessionId, turn: number): Promise<string[]> {
    const root = await this.self.fleetBox.rootHeaderOf(session)
    const found = await this.specOf(root)
    if (found === undefined || found.owner !== root.id) return []
    const { paths } = found.spec
    const outputs = paths.filter(path => path.mode === 'copy-out')
    if (outputs.length === 0 && !paths.some(path => path.mode === 'mount-rw')) return []
    const folder = this.folder(root.id)
    const record = join(folder, 'published.json')
    const published = await readFile(record, 'utf8').then(text => JSON.parse(text) as { turn: number; problems: string[] }, () => undefined)
    if (published !== undefined && published.turn >= turn) return published.problems
    if (this.self.fleetBox.turnRunning(root.id)) return [BUSY]
    const staging = await mkdtemp(join(folder, 'out-'))
    try {
      const signal = AbortSignal.timeout(PUBLISH_TIMEOUT_MS)
      const copies: Record<string, string> = {}
      const problems: string[] = []
      for (const path of outputs) {
        const copy = join(staging, path.name)
        copies[path.view] = copy
        // Nothing left there makes no copy, which the output check reports.
        try {
          await this.self.fleetBox.copyOut(root.id, path.view, copy, MAX_OUTPUT_BYTES, signal)
          problems.push(...await copyProblems(copy, path.name, path.view))
        } catch (error) {
          problems.push(`${path.name}: ${signal.aborted ? `copying took longer than ${PUBLISH_TIMEOUT_MS / 60_000} minutes` : message(error)}`)
        }
      }
      if (problems.length === 0) problems.push(...await outputProblems(paths, copies))
      // A turn that started while copying may have changed what was copied.
      if (this.self.fleetBox.turnRunning(root.id)) return [BUSY]
      for (const path of problems.length === 0 ? outputs : []) {
        await replace(path.host, copies[path.view]!).catch((error: unknown) => {
          problems.push(`${path.name}: could not replace ${path.host}: ${message(error)}`)
        })
      }
      const written = `${record}.${turn}.tmp`
      await writeFile(written, `${JSON.stringify({ turn, problems })}\n`, { mode: 0o600 })
      await rename(written, record)
      return problems
    } finally {
      await rm(staging, { recursive: true, force: true })
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

  /** A fork's container additions: its source's snapshot, since a fork has no folder of its own, and none of its paths or variables. */
  async configureFork(fork: SessionId, found: Found): Promise<void> {
    await this.self.fleetBox.configure(fork, this.additions(found.owner))
  }

  /** A session's container additions: its agent's snapshot, and with its spec, its paths and variables. */
  private additions(owner: SessionId, spec?: Spec): ContainerAdditions {
    const folder = this.folder(owner)
    const mounts: Mount[] = [{ source: join(folder, 'agent'), target: AGENT_VIEW, readonly: true }]
    const directories: string[] = []
    for (const path of spec?.paths ?? []) {
      // The folder a copy-out path goes in, unless it is the container's root, which is always there.
      if (path.mode === 'copy-out') {
        if (posix.dirname(path.view) !== '/') directories.push(posix.dirname(path.view))
      }
      else mounts.push({ source: path.mode === 'copy-in' ? join(folder, 'paths', path.name) : path.host, target: path.view, readonly: path.mode === 'mount-ro' })
    }
    return {
      mounts,
      ...Object.keys(spec?.env ?? {}).length === 0 ? {} : { env: spec!.env },
      ...directories.length === 0 ? {} : { directories: [...new Set(directories)] },
    }
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

  /** Send a job to the worker, starting one if none runs. */
  private post(id: number): void {
    const job = this.jobs.get(id)
    if (job === undefined) return
    const worker = this.startWorker()
    // Held only while it has work, so an idle worker never keeps a process alive.
    worker.ref()
    worker.postMessage({ id, request: job.request } satisfies Job)
  }

  /**
   * A job ran past its time: it fails, and the worker, which may be stuck on
   * it, is replaced by a new one, which takes the jobs still waiting.
   */
  private timedOut(id: number): void {
    const job = this.jobs.get(id)
    if (job === undefined) return
    this.jobs.delete(id)
    job.result.reject(new Error(`fleet-tau: reading ${job.request.agent} took longer than ${this.config.prepareTimeoutMs / 1000} s`))
    const worker = this.worker
    this.worker = undefined
    void worker?.terminate()
    for (const waiting of this.jobs.keys()) this.post(waiting)
  }

  private startWorker(): Worker {
    if (this.worker !== undefined) return this.worker
    const worker = new Worker(new URL('./worker.js', import.meta.url))
    worker.on('message', (answer: Answer) => {
      const job = this.jobs.get(answer.id)
      if (job === undefined) return
      this.jobs.delete(answer.id)
      clearTimeout(job.timer)
      if (this.jobs.size === 0) worker.unref()
      if ('error' in answer) job.result.reject(new Error(`fleet-tau: could not read ${job.request.agent}: ${answer.error}`))
      else job.result.resolve(answer.result)
    })
    // A worker that fails ends every job it holds; the next job starts a new one. One replaced for its time ends none.
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
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer)
      job.result.reject(error)
    }
    this.jobs.clear()
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default FleetTau
