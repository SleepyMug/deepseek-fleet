/**
 * What the model is told about its container: a standing system-prompt
 * section, and a one-time notice when a session's container is newer than its
 * conversation. That happens after an unarchive, a fork, an image update, or a
 * container removed by hand, and everything earlier turns installed or created
 * outside the workspace is gone. A brand-new session never gets the notice,
 * since its container exists before its first message; an ordinary resume
 * never does either, since its container is the same.
 *
 * The notice is an ordinary `user/message` with a `fleet-box` source, added
 * to the next step that already sends messages, so it never makes a model
 * call of its own, and written to the session log once; a projection folds
 * the log back into when the conversation began and which container the last
 * notice described.
 * @module fleet-core/box/context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { z } from 'zod'
import type { SessionContainer } from './world.ts'

const KIND = 'fleet-box'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A notice that the session's container is new; `container` is the Docker id it describes. */
    'fleet-box': { kind: 'fleet-box'; container: string } & ContextFormed
  }
}

const historySchema = z.object({
  /** When the conversation's first message was written, in epoch milliseconds; null before it has one. */
  since: z.number().nullable(),
  /** The container the latest notice described; null before any notice. */
  noticed: z.string().nullable(),
})

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    fleetBoxContainer: z.infer<typeof historySchema>
  }
}

const ENVIRONMENT = 'Your commands and file tools run inside this session\'s own Docker container: Debian, as root, with {{cwd}} '
  + 'mounted from the user\'s machine at the same path. Everything else in the container, such as installed packages and '
  + 'files in /tmp, persists from turn to turn, and you are told if the container is ever replaced. When a command\'s '
  + 'output is long, only its end is kept, so send output you need in full to a file and read that.'

export const name = 'fleet-box-context'
export const inject = ['fleetBox', 'systemPrompt', 'sessionProjections']

export function apply(ctx: Context): void {
  // The web surface's slot among the local paths and endpoints; this bundle turns that section off, since it describes the host.
  ctx.systemPrompt.section({ name: 'fleet-box:environment', order: ctx.systemPrompt.getSectionOrder('WEB_SURFACE'), text: ENVIRONMENT })

  ctx.sessionProjections.register({
    key: 'fleetBoxContainer',
    stateVersion: 1,
    stateSchema: historySchema,
    init: () => ({ since: null, noticed: null }),
    apply: (state, event) => {
      if (event.type !== 'user/message') return state
      if (event.data.source.kind === KIND) return { ...state, noticed: event.data.source.container }
      return state.since === null ? { ...state, since: event.time } : state
    },
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    // dsh skips a step with nothing to send; a notice must not turn it into a model call.
    if (decision.kind === 'reject' || signal.aborted || decision.messages.length === 0) return decision
    const { container } = await ctx.fleetBox.forAgent(agent, signal)
    const history = ctx.sessionProjections.stateOf(agent.session, 'fleetBoxContainer')
    if (history === undefined || history.since === null || history.since >= container.created || history.noticed === container.id) {
      return decision
    }
    return { ...decision, messages: [notice(container), ...decision.messages] }
  }, { prepend: true })
}

function notice(container: SessionContainer) {
  const text = `This session's container is new: it was created after earlier parts of this conversation. `
    + `Anything installed or created outside ${container.workspace} in the previous container, such as packages and files in /tmp, `
    + `is gone; the files in ${container.workspace} are unchanged.`
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: KIND,
      form: 'notice',
      summary: boundContextSummary('This session\'s container is new; what earlier turns installed outside the workspace is gone.'),
      container: container.id,
    },
  })
}
