/**
 * `ctx.subprocess` for the fleet execution world: every process runs in the
 * container of the session whose agent started it, through that session's
 * dsh-ssh helper, and a spawn outside any session's work fails instead of
 * running on the host. `spawn` is synchronous, so it needs the session's world
 * open already: every model step opens it first, and a spawn while the world
 * reconnects fails.
 * @module fleet-world/subprocess
 */

import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalEnvironment, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type {} from './world.ts'

export class FleetWorldSubprocessRuntime extends SubprocessRuntime {
  static inject = ['fleetWorld']

  override async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    return (await this.world('ctx.subprocess.resolveExecutable')).resolveExecutable(command, env, signal)
  }

  override async terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    return (await this.world('ctx.subprocess.terminalEnvironment')).terminalEnvironment(signal)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    return this.ctx.fleetWorld.currentOpen('ctx.subprocess.spawn').subprocess.spawn(spec)
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return (await this.world('ctx.subprocess.spawnTerminal')).spawnTerminal(spec)
  }

  private async world(operation: string): Promise<SubprocessRuntime> {
    return (await this.ctx.fleetWorld.current(operation)).world.subprocess
  }
}

export default FleetWorldSubprocessRuntime
