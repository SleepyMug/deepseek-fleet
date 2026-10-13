/**
 * A tau's session's agent occupies its box while it runs, as a turn, so the
 * box is not stopped for being idle under it: from when it enters `running`,
 * which it does as it is woken, before its first step reaches the box, until
 * it leaves it, or goes.
 * @module @sleepymug/fleet-core/dsh/turns
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { TauBoxes } from '../tau/ports.ts'

/** @param dsh - the context whose agents are followed, for as long as it lives; its end releases every turn. */
export function followTurns(dsh: Context, runs: Pick<TauBoxes, 'isTau' | 'occupy'>): void {
  const turns = new Map<string, () => void>()
  const settle = (agentId: string): void => {
    turns.get(agentId)?.()
    turns.delete(agentId)
  }
  dsh.on('agent/status', ({ agent, status }) => {
    if (status !== 'running') {
      settle(agent.id)
      return
    }
    const sessionId = agent.session.header.id
    if (turns.has(agent.id) || !runs.isTau(sessionId)) return
    turns.set(agent.id, runs.occupy(sessionId, { kind: 'turn', id: agent.id }))
  })
  dsh.on('agent/disposed', ({ agent }) => { settle(agent.id) })
  dsh.effect(() => () => {
    for (const release of turns.values()) release()
    turns.clear()
  }, 'fleet-tau turns')
}
