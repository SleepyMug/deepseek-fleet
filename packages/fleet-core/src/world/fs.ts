/**
 * `ctx.fs` for the fleet profile: a tau's session works on the files of its
 * box, and everything else on the host's, through dsh's own local file
 * system, which this service mounts where only it sees it.
 *
 * A call that names a path, `resolve` and `lstat`, goes to the box of the
 * session it is for (./caller.ts), if that session is a tau's, where the
 * helper serves it with dsh's local file system (fleet-image's
 * helper/cmd/fs.ts). The targets it gives name their box: their key is
 * `fleet-box://<session><path>`, the path in the box of that session, while
 * their display and process paths are the plain path in the box. Every call
 * that takes a target then goes where its key says, whoever makes it. A
 * box's failures are `FsError`s: the helper's own code, or `FS_IO_ERROR`.
 *
 * Not served for a box: watching, which the helper has no means for, and
 * the host's own paths, so the file viewer, whose calls are no session's
 * work, shows the host's folder of a tau's session, not its box.
 * @module fleet-core/world/fs
 */

import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry, FsEditOutcome, FsEditRequest, FsErrorCode, FsInfo, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
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

type FsMethod = Extract<keyof Methods, `fs.${string}`>

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
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const session = await this.boxSession()
    if (session === undefined) return (await this.localReady).resolve(path, opts)
    return outward(session, await this.ask(session, 'fs.resolve', { path, ...cwdOf(opts?.cwd) }))
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
    const session = await this.boxSession()
    if (session === undefined) return (await this.localReady).lstat(path, opts, signal)
    const info = await this.ask(session, 'fs.lstat', { path, ...cwdOf(opts?.cwd) })
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

  override async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    if (inBox(target) !== undefined) return super.watch(target, changed, signal)
    return (await this.localReady).watch(target, changed, signal)
  }

  /** The session the call is for, if it is a tau's, whose box serves it. */
  private async boxSession(): Promise<string | undefined> {
    await this.localReady
    const session = callerSession(this.self, this.ctx)
    return session !== undefined && this.self.fleetTauRuns.isTau(session) ? session : undefined
  }

  /** Ask a session's box, whose failures become `FsError`s. */
  private async ask<M extends FsMethod>(session: string, method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> {
    let box: RunBox | undefined
    try {
      box = await this.self.fleetTauRuns.boxFor(session)
    } catch (error) {
      throw new FsError(`the box of ${session} cannot be started: ${message(error)}`, 'FS_IO_ERROR', { cause: error })
    }
    if (box === undefined) throw new FsError(`${session} is not a tau's session, so it has no box`, 'FS_NOT_FOUND')
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

/** A `cwd` for the helper: a box's target key gives its path. */
function cwdOf(cwd: string | undefined): { cwd?: string } {
  if (cwd === undefined) return {}
  return { cwd: cwd.startsWith(KEY_PREFIX) ? inBox({ targetKey: FsTargetKey(cwd), displayPath: cwd })?.path : cwd }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default FleetFileSystem
