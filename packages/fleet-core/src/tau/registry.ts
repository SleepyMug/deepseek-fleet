/**
 * The tau service's registry: which box each session has, what its run
 * needs, and how far it went, one JSON file per session in a folder of its
 * own, with a folder of each session's own beside it, which keeps its call
 * and its result. The service writes an entry once the session's box is set
 * up, so an entry means a box ready to start, and before the dsh session is
 * made.
 * @module @sleepymug/fleet-core/tau/registry
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Envelope } from '@sleepymug/tau/core'
import { FOLDERS, MODULES } from '@sleepymug/fleet-box-runtime/tau/layout'
import type { Result } from '@sleepymug/fleet-protocol/tau'

/** The ids the service mints: `session-` and a UUID, the form dsh's sessions take. */
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * Who started a run: the host's `tau` command, on the fleet service's
 * socket; or a session: a tau's, from its box, or another, with `tau_run`
 * (../tools/tau.ts).
 */
export type Caller = { kind: 'host' } | { kind: 'session'; sessionId: string }

/** The host's `tau` command, which reaches every run. */
export const HOST: Caller = { kind: 'host' }

/** In a session's folder: the run's call; the tau it carries, read from it while it is admitted; and the run's result. */
export interface SessionFiles {
  folder: string
  call: string
  tau: string
  result: string
}

export interface Entry {
  sessionId: string
  /**
   * Who started the run, who alone, but the host, reaches it; the host for
   * an entry written before callers were.
   */
  caller?: Caller
  /** The box's container. */
  box: string
  /** What names the run, as its caller gave it. */
  title: string
  /**
   * The dsh workspace the session is in, which the web UI lists it under,
   * and its working folder: the caller's folder, through symlinks, or a
   * calling session's own project.
   */
  project: string
  /** The tau's prompt, expanded with where the box has each file. */
  prompt: string
  /** The tau's init, its command, its placeholders expanded, and the agent's working directory in the box, where it runs (./init.ts); none for a tau without one. */
  init?: { command: string; dir: string }
  /** The id the prompt is sent under, so that sending it again is sending it once. */
  promptRequestId: string
  /** When the session was given its prompt, which starts the run. */
  promptedAt?: string
  /** When the run ended, its agent done, and how. */
  ended?: { at: string; result: Result }
  /** When a `finish` first gave back how the run ended. */
  finishedAt?: string
  /** When the box was last set up again from the call, its box having gone, which the agent is told of once (./reset.ts). */
  resetAt?: string
  /** Each file of the run, by name, as the call has it, checked against the tau: its mode, its kind, and its base name. */
  files: Envelope['files']
  /** The agent's working directory in the box, as the box's runtime reported it. */
  cwd: string
  /** Where the tau's code finds its APIs in the box, as the box's runtime reported it. */
  modules: string
  /** The contracts of the tau's APIs, by name, each linked to the client of the extension that implements it. */
  apis: readonly string[]
  /** What the tau exposes to its programs: `@api/<alias>`, or a package of its own, by name, with what it says it is. */
  exposed: readonly { specifier: string; description?: string }[]
  createdAt: string
}

export class Registry {
  /** @param dir - the folder of the entries, made when the first is written. */
  constructor(private readonly dir: string) {}

  /** Write a session's entry, whole or not at all. */
  async put(entry: Entry): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const file = this.file(entry.sessionId)
    await writeFile(`${file}.tmp`, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 })
    await rename(`${file}.tmp`, file)
  }

  /** Change a session's entry as `change` says, written whole; a session without one fails. */
  async update(sessionId: string, change: Partial<Omit<Entry, 'sessionId'>>): Promise<Entry> {
    const entry = { ...await this.get(sessionId), ...change }
    await this.put(entry)
    return entry
  }

  /** A session's entry; a session without one fails. */
  async get(sessionId: string): Promise<Entry> {
    const entry = await this.find(sessionId)
    if (entry === undefined) throw new Error(`fleet: no tau session ${sessionId}`)
    return entry
  }

  /** A session's entry, or undefined for a session without one, such as any dsh session not a tau's. */
  async find(sessionId: string): Promise<Entry | undefined> {
    if (!SESSION_ID.test(sessionId)) return undefined
    try {
      const entry = JSON.parse(await readFile(this.file(sessionId), 'utf8')) as Omit<Entry, 'cwd' | 'modules' | 'title'> & Partial<Entry> & { tauDir?: string }
      // What an entry written before the box's runtime reported them, or before runs had titles, has.
      return { ...entry, title: entry.title ?? basename(entry.tauDir ?? 'tau'), cwd: entry.cwd ?? FOLDERS.inout, modules: entry.modules ?? MODULES }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /** The ids of the sessions with an entry. */
  async list(): Promise<string[]> {
    const names = await readdir(this.dir).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    return names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length)).filter(id => SESSION_ID.test(id))
  }

  /** Every session's entry, oldest first. */
  async entries(): Promise<Entry[]> {
    const entries = await Promise.all((await this.list()).map(sessionId => this.find(sessionId)))
    return entries.filter(entry => entry !== undefined).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Forget a session, its folder, and then its entry; one without either is forgotten already. */
  async delete(sessionId: string): Promise<void> {
    await rm(this.files(sessionId).folder, { recursive: true, force: true })
    await rm(this.file(sessionId), { force: true })
  }

  /** The folder of a session's own, beside its entry, and what it keeps. */
  files(sessionId: string): SessionFiles {
    if (!SESSION_ID.test(sessionId)) throw new Error(`fleet: no tau session ${sessionId}`)
    const folder = join(this.dir, sessionId)
    return { folder, call: join(folder, 'call.tar'), tau: join(folder, 'self'), result: join(folder, 'result.tar') }
  }

  /** An entry's file, for an id of the form the service mints, which is what makes it a file name. */
  private file(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error(`fleet: no tau session ${sessionId}`)
    return join(this.dir, `${sessionId}.json`)
  }
}
