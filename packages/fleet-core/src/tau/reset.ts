/**
 * fleet-tau-reset, as a dsh plugin that fleet-core's `tau` agent preset
 * mounts: before each step of a tau's session that sends messages, it has
 * the session's box ready, set up again from the run's call if it is gone,
 * as after the session was archived and unarchived (./runs.ts), so that a
 * failure to set it up fails the step rather than a tool call; and it tells
 * the model once, with a notice before the step's messages, that its box was
 * set up again and what it did there before is gone. The session's log
 * records the notice, so a projection of it knows which setup was told. A
 * session that is not a tau's, as one a person gives the preset in the web
 * UI, has no box, so each of its steps fails, saying why.
 * @module @sleepymug/fleet-core/tau/reset
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import { FOLDERS, SELF } from '@sleepymug/fleet-box-runtime/tau/layout'
import { z } from 'zod'
import type {} from '../services.ts'
import type { TauBoxes } from './ports.ts'

const KIND = 'fleet-tau-box'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A notice that the session's box was set up again; `resetAt` is when, as the run's entry has it. */
    'fleet-tau-box': { kind: 'fleet-tau-box'; resetAt: string } & ContextFormed
  }
}

const stateSchema = z.object({
  /** When the box was set up again, as the last notice told; null before any. */
  noticed: z.string().nullable(),
})

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    fleetTauBox: z.infer<typeof stateSchema>
  }
}

export const name = 'fleet-tau-reset'
export const inject = ['fleetTauRuns', 'sessionProjections']

/** What the model is told of a box set up again. */
export const NOTICE = `Your box was set up again from your run's call, as it was when your run began: ${SELF}, ${FOLDERS.in}, `
  + `${FOLDERS.inout} and ${FOLDERS.out} hold again what they held then, and whatever you changed or installed in the box since is gone.`

/** Why the step of a session that is not a tau's fails, as of one a person gave this preset. */
export const NOT_A_TAU = 'This session is no run of a TAU, which the `tau` agent preset is for: `tau run --adaptor fleet` and tau_run start those. '
  + 'Start a session with another preset.'

export function apply(ctx: Context): void {
  ctx.sessionProjections.register({
    key: 'fleetTauBox',
    stateVersion: 1,
    stateSchema,
    init: () => ({ noticed: null }),
    apply: (state, event) => event.type === 'user/message' && event.data.source.kind === KIND ? { noticed: event.data.source.resetAt } : state,
  })

  const runs: TauBoxes = ctx.fleetTauRuns
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    // dsh skips a step with nothing to send; a notice must not turn it into a model call.
    if (decision.kind === 'reject' || signal.aborted || decision.messages.length === 0) return decision
    const sessionId = agent.session.header.id
    if (!runs.isTau(sessionId)) throw new Error(NOT_A_TAU)
    await runs.boxFor(sessionId)
    const { resetAt } = await runs.entry(sessionId)
    if (resetAt === undefined || ctx.sessionProjections.stateOf(agent.session, 'fleetTauBox')?.noticed === resetAt) return decision
    const notice = createUserMessage({
      content: [{ type: 'text', text: NOTICE }],
      source: { kind: KIND, form: 'notice', summary: boundContextSummary('This session\'s box was set up again; what earlier turns did in it is gone.'), resetAt },
    })
    return { ...decision, messages: [notice, ...decision.messages] }
  }, { prepend: true })
}
