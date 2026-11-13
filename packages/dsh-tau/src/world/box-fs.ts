/**
 * `ctx.fs` of the boxes of taus' sessions, and of nothing else: the `tau`
 * agent preset's own, for its tools, and what fleet-fs (./fs.ts), the
 * host's, builds on.
 *
 * A call that names a path, `resolve` and `lstat`, goes to a box, whose
 * API serves it as dsh's local file system would there (./box-files.ts):
 * to the box its path or its `cwd` names, written
 * `fleet-box://<session><path>`, or else to the box of the session it is for
 * (./caller.ts), if that session is a tau's. A tau's session's own work may
 * name only its own box, so its model never reaches another's. The targets a
 * box gives are keyed the same way, while their display and process paths
 * are the plain path in the box. Every call that takes a target then goes
 * where its key says, whoever makes it, but a box's files are written for
 * its own session alone, so no other session's model writes them. A box's
 * failures are `FsError`s.
 *
 * Whatever is no box's is not found, so a session that is not a tau's, as
 * one a person gives the `tau` preset, reaches nothing through it; fleet-fs
 * serves it from the host instead. It has no sandbox mode, so dsh's file
 * tools ask for no wider access: a box is its session's to change.
 * @module @sleepymug/dsh-tau/world/box-fs
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo, FsTarget, FsVersion, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { FOLDERS } from '../tau/layout.ts'
import type { BoxApi, Held, TauBoxes } from '../tau/ports.ts'
import type {} from '../services.ts'
import { messageOf } from '../util/error.ts'
import { editTextIn, fsError, listDirIn, lstatIn, readBytesIn, readRangeIn, readTextIn, resolveIn, statIn, writeTextIn } from './box-files.ts'
import { callerSession } from './caller.ts'

/** How a box's target key begins; the session and the path in its box follow. */
export const KEY_PREFIX = 'fleet-box://'

/** A box's target: the session whose box it is in, and the path there. */
interface InBox {
  session: string
  path: string
}

export class BoxFileSystem extends FileSystem {
  static inject = ['fleetTauRuns', 'agents']

  /** The service's own context; `this.ctx` is the context each call reaches it through. */
  protected readonly self: Context
  /** Which sessions are a tau's, and their boxes. */
  protected readonly runs: TauBoxes

  constructor(ctx: Context) {
    super(ctx)
    this.self = ctx
    this.runs = ctx.fleetTauRuns
  }

  /** What serves a call that is no box's: nothing here; fleet-fs gives the host's. */
  protected host(): Promise<FileSystem> {
    return Promise.reject(this.refused())
  }

  /** The same, for a call that cannot wait for it. */
  protected hostNow(): FileSystem {
    throw this.refused()
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const place = this.place(path, opts?.cwd)
    if (place === undefined) return (await this.host()).resolve(path, opts)
    return outward(place.session, await this.ask(place.session, api => resolveIn(api, place.path, place.cwd)))
  }

  override processPath(target: FsTarget): string {
    return inBox(target)?.path ?? this.hostNow().processPath(target)
  }

  /** No host file is in a box, which has only what its run puts there. */
  override processPathFromHostPath(_hostPath: string): string | undefined {
    return undefined
  }

  override fileUrl(target: FsTarget): string {
    const box = inBox(target)
    return box === undefined ? this.hostNow().fileUrl(target) : pathToFileURL(box.path).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const [outer, inner] = [inBox(parent), inBox(child)]
    if (outer === undefined && inner === undefined) return this.hostNow().contains(parent, child)
    if (outer === undefined || inner === undefined || outer.session !== inner.session) return false
    const path = posix.relative(outer.path, inner.path)
    return path === '' || (path !== '..' && !path.startsWith('../') && !posix.isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const box = inBox(target)
    if (box === undefined) return (await this.host()).stat(target, signal)
    return await this.ask(box.session, api => statIn(api, inward(box)))
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const place = this.place(path, opts?.cwd)
    if (place === undefined) return (await this.host()).lstat(path, opts, signal)
    return await this.ask(place.session, api => lstatIn(api, place.path, place.cwd))
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const box = inBox(target)
    if (box === undefined) return (await this.host()).readText(target, signal)
    return await this.ask(box.session, api => readTextIn(api, inward(box)))
  }

  /** A box's text comes in one chunk. */
  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const box = inBox(target)
    if (box === undefined) return (await this.host()).streamText(target, signal)
    const text = await this.readText(target, signal)
    return (async function* () { yield text })()
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const box = inBox(target)
    if (box === undefined) return (await this.host()).readBytes(target, signal, maxBytes)
    return await this.ask(box.session, api => readBytesIn(api, inward(box), maxBytes))
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const box = inBox(target)
    if (box === undefined) return (await this.host()).readByteRange(target, range, signal)
    return await this.ask(box.session, api => readRangeIn(api, inward(box), range))
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const box = inBox(target)
    if (box === undefined) return (await this.host()).listDir(target, signal)
    const entries = await this.ask(box.session, api => listDirIn(api, inward(box)))
    return entries.map(entry => ({ ...entry, target: outward(box.session, entry.target) }))
  }

  /** The host's write gets the rest, the call's sandbox policy; a box's own session writes it with no policy. */
  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, ...rest: unknown[]): Promise<FsWriteOutcome> {
    const box = inBox(target)
    if (box === undefined) return (await this.host()).writeText(target, content, expected, signal, ...rest as [])
    this.writer(box)
    return await this.ask(box.session, api => writeTextIn(api, inward(box), content, expected))
  }

  override async editText(
    target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, ...rest: unknown[]
  ): Promise<FsEditOutcome> {
    const box = inBox(target)
    if (box === undefined) return (await this.host()).editText(target, edit, expected, signal, ...rest as [])
    this.writer(box)
    return await this.ask(box.session, api => editTextIn(api, inward(box), edit, expected))
  }

  /**
   * Watch a box's target until the returned stop, or the signal, ends it. A
   * watch neither starts the box nor keeps it running, since the file viewer
   * holds one for as long as it shows the folder: it is the box's while the
   * box is started; while the box is stopped, as when it was idle, the watch
   * waits, and reports a change as it is the box's again, since the files may
   * have changed meanwhile. A failure while the box runs, or the session's
   * end, is the watch's error.
   */
  override async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    const box = inBox(target)
    if (box === undefined) return (await this.host()).watch(target, changed, signal)
    const runs = this.runs
    const ending = new AbortController()
    const ended = AbortSignal.any([signal, ending.signal])
    const follow = async (): Promise<void> => {
      for (let again = false; ; again = true) {
        const running = await runs.whenStarted(box.session, ended)
        try {
          for await (const { event } of running.api.watch({ path: box.path }, { signal: ended })) {
            // Ready: once the box is the watch's again, what is there may have changed meanwhile.
            if (event.case === 'ready' ? again : true) changed()
          }
          return
        } catch (error) {
          if (ended.aborted) return
          // A box that stops ends the watch, which waits for its next start.
          if (!runs.isStarted(box.session)) continue
          throw error
        }
      }
    }
    follow().catch((error: unknown) => { if (!ended.aborted) changed(fsError(`watch "${box.path}"`, error)) })
    const stop = async (): Promise<void> => {
      ending.abort()
      signal.removeEventListener('abort', abort)
    }
    const abort = (): void => { void stop() }
    if (signal.aborted) await stop()
    else signal.addEventListener('abort', abort, { once: true })
    return stop
  }

  /** The session the call is for, if it is a tau's. */
  protected tauCaller(): string | undefined {
    const caller = callerSession(this.self, this.ctx)
    return caller !== undefined && this.runs.isTau(caller) ? caller : undefined
  }

  /**
   * The box a call naming a path serves from, and what its helper is asked:
   * the box the path or the `cwd` names, if one does, or the box of the
   * session the call is for, if a tau's; or undefined for none. A tau's
   * session's own work may name only its own box.
   */
  private place(path: string, cwd: string | undefined): { session: string; path: string; cwd: string } | undefined {
    const named = inBox(keyed(path)) ?? (cwd === undefined ? undefined : inBox(keyed(cwd)))
    const own = this.tauCaller()
    if (named !== undefined && own !== undefined && named.session !== own) {
      throw new FsError(`${path} is in another session's box`, 'FS_PERMISSION_DENIED')
    }
    const session = named?.session ?? own
    if (session === undefined) return undefined
    // A path in the session's project, where dsh runs its work, is in /tau/workspace in the box.
    const plain = (value: string): string => inBox(keyed(value))?.path ?? this.runs.boxPath(session, value)
    // A relative path without a folder is the agent's working directory's.
    return { session, path: plain(path), cwd: cwd === undefined ? FOLDERS.inout : plain(cwd) }
  }

  /** Refuse a write to a box but for its own session's work. */
  private writer(box: InBox): void {
    if (this.tauCaller() !== box.session) {
      throw new FsError(`cannot write ${box.path}: it is in the box of ${box.session}, which only that session writes`, 'FS_PERMISSION_DENIED')
    }
  }

  /** Nothing but a box is here, so whatever else a call names is not found, as a path dsh looks for, such as a skill's, may not be. */
  private refused(): FsError {
    return new FsError('no such file here: this file system has only the files of a tau\'s session, in its box', 'FS_NOT_FOUND')
  }

  /** Ask a session's box, which the call occupies while it runs; the failures become `FsError`s. */
  private async ask<T>(session: string, call: (api: BoxApi) => Promise<T>): Promise<T> {
    let held: Held | undefined
    try {
      held = await this.runs.hold(session, { kind: 'file', id: randomUUID() })
    } catch (error) {
      throw new FsError(`the box of ${session} cannot be started: ${messageOf(error)}`, 'FS_IO_ERROR', { cause: error })
    }
    if (held === undefined) throw new FsError(`${session} is not a tau's session, so it has no box`, 'FS_NOT_FOUND')
    try {
      return await call(held.box.api)
    } catch (error) {
      throw fsError('reach the box', error)
    } finally {
      held.release()
    }
  }
}

/** A target as dsh is given it: keyed by its box, displayed as the box has it. */
function outward(session: string, target: FsTarget): FsTarget {
  return { targetKey: FsTargetKey(`${KEY_PREFIX}${session}${String(target.targetKey)}`), displayPath: target.displayPath }
}

/** A box's target as the box names it. */
function inward(box: InBox): FsTarget {
  return { targetKey: FsTargetKey(box.path), displayPath: box.path }
}

/** Where a target's key says it is, if in a box. */
function inBox(target: FsTarget): InBox | undefined {
  const key = String(target.targetKey)
  if (!key.startsWith(KEY_PREFIX)) return undefined
  const rest = key.slice(KEY_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) throw new FsError(`${key} names no path in a box`, 'FS_NOT_FOUND')
  return { session: rest.slice(0, slash), path: rest.slice(slash) }
}

/** A path as a target, to read the box it names, if any. */
function keyed(path: string): FsTarget {
  return { targetKey: FsTargetKey(path), displayPath: path }
}

export default BoxFileSystem
