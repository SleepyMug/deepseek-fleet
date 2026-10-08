/**
 * `ctx.subprocess` of a host fleet-core is installed in: a tau's session
 * runs its processes in its box (./box-subprocess.ts), and everything else
 * runs them on the host, through dsh's own local subprocess runtime, which
 * this service mounts where only it sees it. dsh's sandboxed bash confines
 * what it runs through it, as it would through dsh's own.
 * @module @sleepymug/fleet-core/world/subprocess
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { BoxSubprocessRuntime } from './box-subprocess.ts'

export class FleetSubprocessRuntime extends BoxSubprocessRuntime {
  /** dsh's local subprocess runtime, for every process that is not a box's. */
  private local: SubprocessRuntime | undefined
  private readonly localReady: Promise<SubprocessRuntime>

  constructor(ctx: Context) {
    super(ctx)
    // Mounted where only this service sees it, so that it does not stand in for this one.
    const isolated = ctx.isolate('subprocess')
    this.localReady = (async () => {
      await isolated.plugin(LocalSubprocessRuntime)
      this.local = isolated.get('subprocess') as SubprocessRuntime
      return this.local
    })()
  }

  protected override host(): Promise<SubprocessRuntime> {
    return this.localReady
  }

  /** For a call that cannot wait for it; every call after startup finds it there. */
  protected override hostNow(): SubprocessRuntime {
    if (this.local === undefined) throw new Error('fleet: ctx.subprocess is starting')
    return this.local
  }
}

export default FleetSubprocessRuntime
