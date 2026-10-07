/**
 * The tau service's registry: which box each session has, what its run
 * needs, and how far it went, one JSON file per session in a folder of its
 * own. The service writes an entry once the session's box is set up, so an
 * entry means a box ready to start, and before the dsh session is made.
 * @module fleet-core/tau/registry
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { BoundFile } from '@sleepymug/tau'
import { FOLDERS, MODULES } from 'fleet-box-runtime/tau/layout'
import type { Result, Targets } from 'fleet-protocol/tau'

/** The ids the service mints: `session-` and a UUID, the form dsh's sessions take. */
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * Who started a run: `fleet`, on the host; or a session: a tau's, from its
 * box, or another, with `tau_run` (../tools/tau.ts).
 */
export type Caller = { kind: 'host' } | { kind: 'session'; sessionId: string }

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
  /** Each file of the run, as the call names it: its name, its mode, its kind, its base name, and where the box has it. */
  files: readonly BoundFile[]
  /** Where the caller has each `out` and `inout` file, which `finish` gives back. */
  targets: Targets
  /** The agent's working directory in the box, as the box's runtime reported it. */
  cwd: string
  /** Where the tau's code finds its APIs in the box, as the box's runtime reported it. */
  modules: string
  /** The APIs the tau declares, by name, each linked to the client of the extension that implements it. */
  apis: readonly string[]
  /** What the tau exposes to its programs: `@api/<name>`, or a package of its own, by name, with what it says it is. */
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

  /** Forget a session; one without an entry is forgotten already. */
  async delete(sessionId: string): Promise<void> {
    await rm(this.file(sessionId), { force: true })
  }

  /** A folder of a session's own, beside its entry: its call, and its result. */
  folder(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error(`fleet: no tau session ${sessionId}`)
    return join(this.dir, sessionId)
  }

  /** An entry's file, for an id of the form the service mints, which is what makes it a file name. */
  private file(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error(`fleet: no tau session ${sessionId}`)
    return join(this.dir, `${sessionId}.json`)
  }
}
