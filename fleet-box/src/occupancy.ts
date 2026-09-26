/**
 * What occupies each root session's container: the work that needs it
 * running now. The world stops a container on its own only while nothing
 * occupies it (./world.ts), which holds as long as every kind of occupant
 * keeps two promises: it is visible here before it can reach the container,
 * and stays visible until nothing of it can. A third keeps idle containers
 * from running on: whatever ends an occupant reports a vacancy, which only
 * prompts the world to look again, so a missed one delays a stop and never
 * causes a wrong one.
 *
 * Turns are read from the agent registry each time rather than kept: a live
 * agent of the session or of its subagents that is running. An agent enters
 * `running` synchronously when woken, before its first step opens the
 * container, and leaves it once no driver remains, which it reports with
 * `agent/status`. Everything else is fleet-box's own and kept here: the
 * user's terminals, and the processes and calls fleet-box runs in the
 * container.
 * @module fleet-box/occupancy
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/** Something that needs a root session's container running now. */
export interface Occupant {
  /**
   * `turn`: an agent of the session or of a subagent is running.
   * `terminal`: a user's shell, until none of its processes is left.
   * `process`: a process fleet-box started, until it exits; what it leaves in its group does not count.
   * `call`: a request fleet-box makes to the helper for a caller, such as an executable lookup, while it runs.
   */
  kind: 'turn' | 'terminal' | 'process' | 'call'
  /** The agent's session id, or the terminal's, process's or call's own id. */
  id: string
}

export interface OccupancyOptions {
  /** The live agents. */
  agents(): Iterable<Agent>
  /** The root session whose container a session uses; undefined when its lineage is not loaded. */
  rootOf(header: SessionHeader): SessionId | undefined
  /** A root session's container may have lost its last occupant. */
  vacated(root: SessionId): void
}

export class Occupancy {
  /** fleet-box's own occupants, by root session. */
  private readonly uses = new Map<SessionId, Map<symbol, Occupant>>()

  constructor(private readonly options: OccupancyOptions) {}

  /** Everything occupying a root session's container, read now. */
  of(root: SessionId): Occupant[] {
    const occupants: Occupant[] = []
    for (const agent of this.options.agents()) {
      if (agent.status === 'running' && this.options.rootOf(agent.session.header) === root) occupants.push({ kind: 'turn', id: agent.id })
    }
    return [...occupants, ...this.uses.get(root)?.values() ?? []]
  }

  /**
   * Occupy a root session's container. Call this before asking for the world,
   * and release it once nothing of the occupant can reach the container.
   * @returns an idempotent release, which reports the vacancy.
   */
  occupy(root: SessionId, occupant: Occupant): () => void {
    let uses = this.uses.get(root)
    if (uses === undefined) {
      uses = new Map()
      this.uses.set(root, uses)
    }
    const held = uses
    const token = Symbol(occupant.id)
    held.set(token, occupant)
    return () => {
      if (!held.delete(token)) return
      if (held.size === 0 && this.uses.get(root) === held) this.uses.delete(root)
      this.options.vacated(root)
    }
  }

  /** An agent stopped running or left the registry, so its root session's container may be vacant. */
  settled(agent: Agent): void {
    const root = this.options.rootOf(agent.session.header)
    if (root !== undefined) this.options.vacated(root)
  }
}
