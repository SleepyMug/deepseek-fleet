/**
 * Which session a call to fleet-core's `ctx.fs` or `ctx.subprocess` is for:
 * the session of the agent whose turn makes it, or else of the agent whose
 * scoped context the caller reached the service through, as dsh's terminal
 * controller reaches `ctx.subprocess` through `agent.ctx`. A call that is no
 * session's work, such as the file viewer's, is for none.
 * @module fleet-core/world/caller
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'

/**
 * @param self - the service's own context.
 * @param caller - the context the service was reached through, its traced `this.ctx`.
 * @returns the session's id, or undefined.
 */
export function callerSession(self: Context, caller: Context): string | undefined {
  const agent = self.agents.currentInitiator() ?? scopedAgent(self, caller)
  return agent?.session.header.id
}

/** The live agent a context is scoped to (@deepseek-ai/dsh-scope), if any. */
function scopedAgent(self: Context, caller: Context): Agent | undefined {
  const key = scopeOf(caller)
  if (typeof key !== 'object' || key === null || !('id' in key)) return undefined
  const agent = self.agents.get((key as Agent).id)
  return agent === key ? agent : undefined
}
