/**
 * `ctx.fs` for the fleet profile: a tau's session works on the files of its
 * box, and everything else on the host's, through dsh's own local file
 * system, which this service mounts where only it sees it.
 *
 * A call that names a path, `resolve` and `lstat`, goes to a box where the
 * helper serves it with dsh's local file system (fleet-image's
 * helper/cmd/fs.ts): to the box its path or its `cwd` names, written
 * `fleet-box://<session><path>`, or else to the box of the session it is for
 * (./caller.ts), if that session is a tau's. A tau's session's own work may
 * name only its own box, so its model never reaches another's. The targets a
 * box gives are keyed the same way, while their display and process paths
 * are the plain path in the box. Every call that takes a target then goes
 * where its key says, whoever makes it. A box's failures are `FsError`s: the
 * helper's own code, or `FS_IO_ERROR`.
 *
 * The file viewer's service finds a session's folder through dsh's
 * `workspaceFileScope` lookup, which this service configures: a tau's
 * session's is `fleet-box://<session>/tau` in its box, and any other's what
 * dsh gives, its folder on the host. The viewer passes it on to every file
 * call, as the path or the `cwd`, so its tree, previews and live refresh
 * are the box's.
 * @module fleet-core/world/fs
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsErrorCode, FsInfo, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { Methods, Target } from 'fleet-image/helper/protocol'
import { HelperError } from '../box/helper.ts'
import type { RunBox } from '../tau/runs.ts'
import type {} from '../tau/runs-plugin.ts'
import { callerSession } from './caller.ts'

/** How a box's target key begins; the session and the path in its box follow. */
const KEY_PREFIX = 'fleet-box://'

const FS_ERROR_CODES: ReadonlySet<string> = new Set<FsErrorCode>([
  'FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE', 'FS_TOO_LARGE', 'FS_PERMISSION_DENIED',
  'FS_SANDBOX_DENIED', 'FS_IO_ERROR', 'FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_AMBIGUOUS_EDIT', 'FS_EDIT_NOT_FOUND', 'FS_ABORTED',
])

/** A box's target: the session whose box it is in, and the path there. */
interface InBox {
  session: string
  path: string
}

/** The folder of a tau's session the file viewer shows: the tau's folders in its box. */
const VIEWED = '/tau'

type FsMethod = Exclude<Extract<keyof Methods, `fs.${string}`>, 'fs.watch' | 'fs.unwatch'>

export class FleetFileSystem extends FileSystem {
  static inject = ['fleetTauRuns', 'agents']

  private readonly self: Context
  /** dsh's local file system, for every call that is not a box's. */
  private local: FileSystem | undefined
  private readonly localReady: Promise<FileSystem>

  constructor(ctx: Context) {
    super(ctx)
    this.self = ctx
    // Mounted where only this service sees it, so that it does not stand in for this one.
    const isolated = ctx.isolate('fs')
    this.localReady = (async () => {
      await isolated.plugin(LocalFileSystem, {})
      this.local = isolated.get('fs') as FileSystem
      return this.local
    })()
    // The file viewer's service is given a tau's session's folder in its box, and passes it on to every file call.
    ctx.inject(['typert'], (inner) => {
      inner.typert.lookups.configure('workspaceFileScope', sessionId => this.fileScope(inner, sessionId))
    })
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const place = await this.place(path, opts?.cwd)
    if (place === undefined) return (await this.localReady).resolve(path, opts)
    return outward(place.session, await this.ask(place.session, 'fs.resolve', place.params))
  }

  override processPath(target: FsTarget): string {
    return inBox(target)?.path ?? this.localNow().processPath(target)
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    return this.localNow().processPathFromHostPath(hostPath)
  }

  override fileUrl(target: FsTarget): string {
    const box = inBox(target)
    return box === undefined ? this.localNow().fileUrl(target) : pathToFileURL(box.path).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const [outer, inner] = [inBox(parent), inBox(child)]
    if (outer === undefined && inner === undefined) return this.localNow().contains(parent, child)
    if (outer === undefined || inner === undefined || outer.session !== inner.session) return false
    const path = posix.relative(outer.path, inner.path)
    return path === '' || (path !== '..' && !path.startsWith('../') && !posix.isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const box = inBox(target)
    if (box === undefined) return (await this.localReady).stat(target, signal)
    const info = await this.ask(box.session, 'fs.stat', { target: inward(box) })
    return info === null ? undefined : { ...info, version: FsVersion(info.version) }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const place = await this.place(path, opts?.cwd)
    if (place === undefined) return (await this.localReady).lstat(path, opts, signal)
    const info = await this.ask(place.session, 'fs.lstat', place.params)
    return info === null ? undefined : { ...info, version: FsVersion(info.version) }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const box = inBox(target)
    if (box === undefined) return (await this.localReady).readText(target, signal)
    return this.ask(box.session, 'fs.readText', { target: inward(box) })
  }

  /** A box's text comes in one chunk. */
  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const box = inBox(target)
    if (box === undefined) return (await this.localReady).streamText(target, signal)
    const text = await this.readText(target, signal)
    return (async function* () { yield text })()
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const box = inBox(target)
    if (box === undefined) return (await this.localReady).readBytes(target, signal, maxBytes)
    return Buffer.from(await this.ask(box.session, 'fs.readBytes', { target: inward(box), maxBytes }), 'base64')
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const box = inBox(target)
    if (box === undefined) return (await this.localReady).readByteRange(target, range, signal)
    return Buffer.from(await this.ask(box.session, 'fs.readRange', { target: inward(box), ...range }), 'base64')
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const box = inBox(target)
    if (box === undefined) return (await this.localReady).listDir(target, signal)
    const entries = await this.ask(box.session, 'fs.listDir', { target: inward(box) })
    return entries.map(({ version, target: entry, ...rest }) => ({
      ...rest,
      target: outward(box.session, entry),
      ...version === undefined ? {} : { version: FsVersion(version) },
    }))
  }

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, ...rest: unknown[]): Promise<FsWriteOutcome> {
    const box = inBox(target)
    if (box === undefined) return (await this.localReady).writeText(target, content, expected, signal, ...rest as [])
    const outcome = await this.ask(box.session, 'fs.writeText', { target: inward(box), content, ...expected === undefined ? {} : { expected } })
    return { ...outcome, version: FsVersion(outcome.version) }
  }

  override async editText(
    target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, ...rest: unknown[]
  ): Promise<FsEditOutcome> {
    const box = inBox(target)
    if (box === undefined) return (await this.localReady).editText(target, edit, expected, signal, ...rest as [])
    const outcome = await this.ask(box.session, 'fs.editText', {
      target: inward(box), edit: { oldString: edit.oldString, newString: edit.newString, replaceAll: edit.replaceAll },
      ...expected === undefined ? {} : { expected: { version: expected.version } },
    })
    return { ...outcome, version: FsVersion(outcome.version) }
  }

  /**
   * Watch a box's target through its helper until the returned stop, or the
   * signal, ends it; a box lost meanwhile is reported as the watch's error.
   */
  override async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    const box = inBox(target)
    if (box === undefined) return (await this.localReady).watch(target, changed, signal)
    const watch = randomUUID()
    const running = await this.boxOf(box.session)
    const watching = running.request('fs.watch', { watch, target: inward(box) }, (event) => {
      changed(event.error === null ? undefined : new FsError(event.error, 'FS_IO_ERROR'))
    })
    let stopped = false
    // A watch that fails, its box lost, is reported; one ended here answers.
    watching.catch((error: unknown) => { if (!stopped) changed(new FsError(message(error), 'FS_IO_ERROR', { cause: error })) })
    const stop = async (): Promise<void> => {
      if (stopped) return
      stopped = true
      signal.removeEventListener('abort', abort)
      await running.request('fs.unwatch', { watch }).catch(() => {})
    }
    const abort = (): void => { void stop() }
    if (signal.aborted) await stop()
    else signal.addEventListener('abort', abort, { once: true })
    return stop
  }

  /**
   * The box a call naming a path serves from, and what its helper is asked:
   * the box the path or the `cwd` names, if one does, or the box of the
   * session the call is for, if a tau's; or undefined for the host. A tau's
   * session's own work may name only its own box.
   */
  private async place(path: string, cwd: string | undefined): Promise<{ session: string; params: { path: string; cwd?: string } } | undefined> {
    await this.localReady
    const named = inBox(keyed(path)) ?? (cwd === undefined ? undefined : inBox(keyed(cwd)))
    const caller = callerSession(this.self, this.ctx)
    const own = caller !== undefined && this.self.fleetTauRuns.isTau(caller) ? caller : undefined
    if (named !== undefined && own !== undefined && named.session !== own) {
      throw new FsError(`${path} is in another session's box`, 'FS_PERMISSION_DENIED')
    }
    const session = named?.session ?? own
    if (session === undefined) return undefined
    const plain = (value: string): string => inBox(keyed(value))?.path ?? value
    return { session, params: { path: plain(path), ...cwd === undefined ? {} : { cwd: plain(cwd) } } }
  }

  /** dsh's `workspaceFileScope`: a tau's session's folder in its box, and any other's as dsh gives it. */
  private async fileScope(ctx: Context, sessionId: string): Promise<WorkspaceFileScope | undefined> {
    if (this.self.fleetTauRuns.isTau(sessionId)) return { sessionId, workspaceRoot: `${KEY_PREFIX}${sessionId}${VIEWED}` } as WorkspaceFileScope
    // What the file viewer's service gives without this lookup configured.
    const id = sessionId as SessionId
    const header = ctx.get('sessions')?.get(id)?.header ?? (await ctx.get('sessionPersistence')?.stat(id))?.header
    if (header === undefined) return undefined
    return { sessionId, workspaceRoot: header.cwd ?? ctx.get('sandboxPolicy')?.workspaceRoot } as WorkspaceFileScope
  }

  /** A session's started box, whose failures become `FsError`s. */
  private async boxOf(session: string): Promise<RunBox> {
    let box: RunBox | undefined
    try {
      box = await this.self.fleetTauRuns.boxFor(session)
    } catch (error) {
      throw new FsError(`the box of ${session} cannot be started: ${message(error)}`, 'FS_IO_ERROR', { cause: error })
    }
    if (box === undefined) throw new FsError(`${session} is not a tau's session, so it has no box`, 'FS_NOT_FOUND')
    return box
  }

  /** Ask a session's box, whose failures become `FsError`s. */
  private async ask<M extends FsMethod>(session: string, method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
    const box = await this.boxOf(session)
    try {
      return await box.request(method, params)
    } catch (error) {
      if (error instanceof HelperError && error.code !== undefined && FS_ERROR_CODES.has(error.code)) {
        throw new FsError(error.message, error.code as FsErrorCode, { cause: error })
      }
      throw new FsError(message(error), 'FS_IO_ERROR', { cause: error })
    }
  }

  /** The local file system, for a call that cannot wait for it; every call after startup finds it there. */
  private localNow(): FileSystem {
    if (this.local === undefined) throw new FsError('the file system is starting', 'FS_IO_ERROR')
    return this.local
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

export default FleetFileSystem
