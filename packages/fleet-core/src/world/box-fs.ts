/**
 * `ctx.fs` of the boxes of taus' sessions, and of nothing else: the `tau`
 * agent preset's own, for its tools, and what fleet-fs (./fs.ts), the
 * host's, builds on.
 *
 * A call that names a path, `resolve` and `lstat`, goes to a box where the
 * helper serves it with dsh's local file system (fleet-box-runtime's
 * helper/cmd/fs.ts): to the box its path or its `cwd` names, written
 * `fleet-box://<session><path>`, or else to the box of the session it is for
 * (./caller.ts), if that session is a tau's. A tau's session's own work may
 * name only its own box, so its model never reaches another's. The targets a
 * box gives are keyed the same way, while their display and process paths
 * are the plain path in the box. Every call that takes a target then goes
 * where its key says, whoever makes it, but a box's files are written for
 * its own session alone, so no other session's model writes them. A box's
 * failures are `FsError`s: the helper's own code, or `FS_IO_ERROR`.
 *
 * Whatever is no box's is not found, so a session that is not a tau's, as
 * one a person gives the `tau` preset, reaches nothing through it; fleet-fs
 * serves it from the host instead. It has no sandbox mode, so dsh's file
 * tools ask for no wider access: a box is its session's to change.
 * @module @sleepymug/fleet-core/world/box-fs
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsErrorCode, FsInfo, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { Methods, Target } from '@sleepymug/fleet-box-runtime/helper/protocol'
import { HelperError } from '../box/helper.ts'
import type { RunBox, TauRuns } from '../tau/runs.ts'
import type {} from '../tau/runs-plugin.ts'
import { callerSession } from './caller.ts'

/** How a box's target key begins; the session and the path in its box follow. */
export const KEY_PREFIX = 'fleet-box://'

const FS_ERROR_CODES: ReadonlySet<string> = new Set<FsErrorCode>([
  'FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE', 'FS_TOO_LARGE', 'FS_PERMISSION_DENIED',
  'FS_SANDBOX_DENIED', 'FS_IO_ERROR', 'FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_AMBIGUOUS_EDIT', 'FS_EDIT_NOT_FOUND', 'FS_ABORTED',
])

/** A box's target: the session whose box it is in, and the path there. */
interface InBox {
  session: string
  path: string
}

type FsMethod = Exclude<Extract<keyof Methods, `fs.${string}`>, 'fs.watch' | 'fs.unwatch'>

export class BoxFileSystem extends FileSystem {
  static inject = ['fleetTauRuns', 'agents']

  /** The service's own context; `this.ctx` is the context each call reaches it through. */
  protected readonly self: Context

  constructor(ctx: Context) {
    super(ctx)
    this.self = ctx
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
    return outward(place.session, await this.ask(place.session, 'fs.resolve', place.params))
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
    const info = await this.ask(box.session, 'fs.stat', { target: inward(box) })
    return info === null ? undefined : { ...info, version: FsVersion(info.version) }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const place = this.place(path, opts?.cwd)
    if (place === undefined) return (await this.host()).lstat(path, opts, signal)
    const info = await this.ask(place.session, 'fs.lstat', place.params)
    return info === null ? undefined : { ...info, version: FsVersion(info.version) }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const box = inBox(target)
    if (box === undefined) return (await this.host()).readText(target, signal)
    return this.ask(box.session, 'fs.readText', { target: inward(box) })
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
    return Buffer.from(await this.ask(box.session, 'fs.readBytes', { target: inward(box), maxBytes }), 'base64')
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const box = inBox(target)
    if (box === undefined) return (await this.host()).readByteRange(target, range, signal)
    return Buffer.from(await this.ask(box.session, 'fs.readRange', { target: inward(box), ...range }), 'base64')
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const box = inBox(target)
    if (box === undefined) return (await this.host()).listDir(target, signal)
    const entries = await this.ask(box.session, 'fs.listDir', { target: inward(box) })
    return entries.map(({ version, target: entry, ...rest }) => ({
      ...rest,
      target: outward(box.session, entry),
      ...version === undefined ? {} : { version: FsVersion(version) },
    }))
  }

  /** The host's write gets the rest, the call's sandbox policy; a box's own session writes it with no policy. */
  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, ...rest: unknown[]): Promise<FsWriteOutcome> {
    const box = inBox(target)
    if (box === undefined) return (await this.host()).writeText(target, content, expected, signal, ...rest as [])
    this.writer(box)
    const outcome = await this.ask(box.session, 'fs.writeText', { target: inward(box), content, ...expected === undefined ? {} : { expected } })
    return { ...outcome, version: FsVersion(outcome.version) }
  }

  override async editText(
    target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, ...rest: unknown[]
  ): Promise<FsEditOutcome> {
    const box = inBox(target)
    if (box === undefined) return (await this.host()).editText(target, edit, expected, signal, ...rest as [])
    this.writer(box)
    const outcome = await this.ask(box.session, 'fs.editText', {
      target: inward(box), edit: { oldString: edit.oldString, newString: edit.newString, replaceAll: edit.replaceAll },
      ...expected === undefined ? {} : { expected: { version: expected.version } },
    })
    return { ...outcome, version: FsVersion(outcome.version) }
  }

  /**
   * Watch a box's target through its helper until the returned stop, or the
   * signal, ends it. A watch neither starts the box nor keeps it running,
   * since the file viewer holds one for as long as it shows the folder: it
   * is the box's helper's while the box is started; while the box is
   * stopped, as when it was idle, the watch waits, and reports a change as
   * it is the helper's again, since the files may have changed meanwhile.
   * A failure while the box runs, or the session's end, is the watch's error.
   */
  override async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    const box = inBox(target)
    if (box === undefined) return (await this.host()).watch(target, changed, signal)
    const runs = this.self.fleetTauRuns
    const ending = new AbortController()
    const ended = AbortSignal.any([signal, ending.signal])
    let attached: { running: RunBox; watch: string } | undefined
    const follow = async (): Promise<void> => {
      for (let again = false; ; again = true) {
        const running = await runs.whenStarted(box.session, ended)
        if (again) changed()
        const watch = randomUUID()
        attached = { running, watch }
        try {
          // The helper answers a watch once it is unwatched.
          await running.request('fs.watch', { watch, target: inward(box) }, (event) => {
            changed(event.error === null ? undefined : new FsError(event.error, 'FS_IO_ERROR'))
          })
          return
        } catch (error) {
          // A box that stops ends its helper, and the watch with it, which waits for its next start.
          if (ended.aborted || !runs.isStarted(box.session)) continue
          throw error
        } finally {
          attached = undefined
        }
      }
    }
    follow().catch((error: unknown) => { if (!ended.aborted) changed(new FsError(message(error), 'FS_IO_ERROR', { cause: error })) })
    const stop = async (): Promise<void> => {
      if (ending.signal.aborted) return
      ending.abort()
      signal.removeEventListener('abort', abort)
      const current = attached
      if (current !== undefined) await current.running.request('fs.unwatch', { watch: current.watch }).catch(() => {})
    }
    const abort = (): void => { void stop() }
    if (signal.aborted) await stop()
    else signal.addEventListener('abort', abort, { once: true })
    return stop
  }

  /** The session the call is for, if it is a tau's. */
  protected tauCaller(): string | undefined {
    const caller = callerSession(this.self, this.ctx)
    return caller !== undefined && this.self.fleetTauRuns.isTau(caller) ? caller : undefined
  }

  /**
   * The box a call naming a path serves from, and what its helper is asked:
   * the box the path or the `cwd` names, if one does, or the box of the
   * session the call is for, if a tau's; or undefined for none. A tau's
   * session's own work may name only its own box.
   */
  private place(path: string, cwd: string | undefined): { session: string; params: { path: string; cwd?: string } } | undefined {
    const named = inBox(keyed(path)) ?? (cwd === undefined ? undefined : inBox(keyed(cwd)))
    const own = this.tauCaller()
    if (named !== undefined && own !== undefined && named.session !== own) {
      throw new FsError(`${path} is in another session's box`, 'FS_PERMISSION_DENIED')
    }
    const session = named?.session ?? own
    if (session === undefined) return undefined
    // A path in the session's project, where dsh runs its work, is in /tau/workspace in the box.
    const plain = (value: string): string => inBox(keyed(value))?.path ?? this.self.fleetTauRuns.boxPath(session, value)
    return { session, params: { path: plain(path), ...cwd === undefined ? {} : { cwd: plain(cwd) } } }
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
  private async ask<M extends FsMethod>(session: string, method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
    let held: Awaited<ReturnType<TauRuns['hold']>>
    try {
      held = await this.self.fleetTauRuns.hold(session, { kind: 'file', id: randomUUID() })
    } catch (error) {
      throw new FsError(`the box of ${session} cannot be started: ${message(error)}`, 'FS_IO_ERROR', { cause: error })
    }
    if (held === undefined) throw new FsError(`${session} is not a tau's session, so it has no box`, 'FS_NOT_FOUND')
    try {
      return await held.box.request(method, params)
    } catch (error) {
      if (error instanceof HelperError && error.code !== undefined && FS_ERROR_CODES.has(error.code)) {
        throw new FsError(error.message, error.code as FsErrorCode, { cause: error })
      }
      throw new FsError(message(error), 'FS_IO_ERROR', { cause: error })
    } finally {
      held.release()
    }
  }
}

/** A target as dsh is given it: keyed by its box. */
function outward(session: string, target: Target): FsTarget {
  return { targetKey: FsTargetKey(`${KEY_PREFIX}${session}${target.targetKey}`), displayPath: target.targetKey }
}

/** A box's target as its helper names it. */
function inward(box: InBox): Target {
  return { targetKey: box.path, displayPath: box.path }
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default BoxFileSystem
