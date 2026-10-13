/**
 * `ctx.fs` of a host fleet-core is installed in: a tau's session works on
 * the files of its box (./box-fs.ts), and everything else on the host's,
 * through dsh's own sandboxed file system, as dsh-base's `fs-sandbox` row
 * has it, which this service mounts where only it sees it. A host call is
 * that file system's, its sandbox policy too, and so is the sandbox mode
 * this service reports, so dsh's file tools ask for wider access as they
 * would of it.
 *
 * The file viewer's service finds a session's folder through dsh's
 * `workspaceFileScope` lookup, which this service configures: a tau's
 * session's is `fleet-box://<session>/tau` in its box, and any other's what
 * dsh gives, its folder on the host. The viewer passes it on to every file
 * call, as the path or the `cwd`, so its tree, previews and live refresh
 * are the box's.
 *
 * dsh asks where a host file is in the world of the session it works for,
 * to tell its model where a stored attachment is: an image it was shown, or
 * a file uploaded to it. For a tau's session, a file of dsh's attachment
 * store is at its place under /fleet/attachments in its box, which the runs
 * copy it to as it is asked for; there the store's files never change. Any
 * other host file is not in its world.
 * @module @sleepymug/fleet-core/world/fs
 */

import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import { fleetPaths } from '../paths.ts'
import { BoxFileSystem, KEY_PREFIX } from './box-fs.ts'

/** The folder of a tau's session the file viewer shows: the tau's folders in its box. */
const VIEWED = '/tau'

/** Where a box has the files of dsh's attachment store, as they are in the store. */
const ATTACHMENTS = '/fleet/attachments'

export interface Config {
  /** The dsh home, absolute, whose attachments/ is dsh's attachment store. */
  dshHome: string
}

export class FleetFileSystem extends BoxFileSystem {
  static override inject = ['fleetTauRuns', 'agents', 'sandboxPolicy']

  /** dsh's sandboxed file system, for every call that is not a box's. */
  private local: FileSystem | undefined
  private readonly localReady: Promise<FileSystem>
  /** dsh's attachment store on the host. */
  private readonly store: string

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.store = fleetPaths(config?.dshHome, 'fleet-fs').attachments
    // Mounted where only this service sees it, so that it does not stand in for this one.
    const isolated = ctx.isolate('fs')
    this.localReady = (async () => {
      await isolated.plugin(SandboxedFileSystem, {})
      this.local = isolated.get('fs') as FileSystem
      return this.local
    })()
    // The file viewer's service is given a tau's session's folder in its box, and passes it on to every file call.
    ctx.inject(['typert'], (inner) => {
      inner.typert.lookups.configure('workspaceFileScope', sessionId => this.fileScope(inner, sessionId))
    })
  }

  /** The deployment's default, as dsh's sandboxed file system reports it. */
  override get sandboxMode(): SandboxMode {
    return this.self.sandboxPolicy.defaultMode
  }

  protected override host(): Promise<FileSystem> {
    return this.localReady
  }

  /** For a call that cannot wait for it; a host target comes of a call that waited, so it is there. */
  protected override hostNow(): FileSystem {
    if (this.local === undefined) throw new FsError('the file system is starting', 'FS_IO_ERROR')
    return this.local
  }

  /**
   * For a tau's session, a file of dsh's attachment store is at its place in
   * the box, which the runs copy it to before the box's next use; any other
   * host file is not there.
   */
  override processPathFromHostPath(hostPath: string): string | undefined {
    const caller = this.tauCaller()
    if (caller === undefined) return this.hostNow().processPathFromHostPath(hostPath)
    if (!isAbsolute(hostPath)) return undefined
    const stored = relative(this.store, resolve(hostPath))
    if (stored === '' || stored === '..' || stored.startsWith(`..${sep}`) || isAbsolute(stored)) return undefined
    const place = posix.join(ATTACHMENTS, ...stored.split(sep))
    this.runs.copyInOnce(caller, resolve(hostPath), place)
    return place
  }

  /** dsh's `workspaceFileScope`: a tau's session's folder in its box, and any other's as dsh gives it. */
  private async fileScope(ctx: Context, sessionId: string): Promise<WorkspaceFileScope | undefined> {
    if (this.runs.isTau(sessionId)) return { sessionId, workspaceRoot: `${KEY_PREFIX}${sessionId}${VIEWED}` } as WorkspaceFileScope
    // What the file viewer's service gives without this lookup configured.
    const id = sessionId as SessionId
    const header = ctx.get('sessions')?.get(id)?.header ?? (await ctx.get('sessionPersistence')?.stat(id))?.header
    if (header === undefined) return undefined
    return { sessionId, workspaceRoot: header.cwd ?? ctx.get('sandboxPolicy')?.workspaceRoot } as WorkspaceFileScope
  }
}

export default FleetFileSystem
