/**
 * fleet-tau-prompt, the system prompt of a tau's session, as a dsh plugin
 * that fleet-core's `tau` agent preset mounts, so it shapes only the prompts
 * of the sessions that preset makes: it tells the model where it works, its
 * box, and its working directory there, /tau/workspace
 * (fleet-image/tau/layout), and
 * leaves out the sections dsh writes for a person at the host, which are
 * false in a box, and the runtime context on the host's sandbox policy.
 * @module fleet-core/tau/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { FOLDERS } from 'fleet-image/tau/layout'

export const name = 'fleet-tau-prompt'
export const inject = ['systemPrompt']

/**
 * dsh's sections about the host, by name: the harness's checkout on it, the
 * web GUI at its URL, the web UI's file cards and links, and `@` mentions as
 * paths on it.
 */
export const HOST_SECTIONS: ReadonlySet<string> = new Set([
  'harness:source',
  'app:web-surface',
  'ui:deliverable-file-references',
  'context:file-reference',
])

/**
 * dsh's runtime contexts about the host, by name: the sandbox policy, full
 * access, which is the host's file policy, not the box's.
 */
export const HOST_CONTEXTS: ReadonlySet<string> = new Set([
  'sandbox:policy',
])

/** Where the model works, which follows the persona. */
export const WHERE = `You work in a box of your own, a container, which your tools act on: bash, the file tools, and your TypeScript programs. Your working directory is ${FOLDERS.inout}.`

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'fleet:tau-where',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
    text: WHERE,
  })
  // Prepended, so it sees the assembly once every other listener has had it.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return {
      ...assembly,
      sections: assembly.sections.filter(section => !HOST_SECTIONS.has(section.name)),
      contexts: assembly.contexts.filter(context => !HOST_CONTEXTS.has(context.name)),
    }
  }, { prepend: true })
}
