/**
 * fleet-tau-prompt, the system prompt of a tau's session, as a dsh plugin
 * that fleet-core's `tau` agent preset mounts, so it shapes only the prompts
 * of the sessions that preset makes: it tells the model where it works, its
 * box, its working directory there, /tau/workspace, and where tau's
 * TAU.md is, /tau/TAU.md (fleet-box-runtime/tau/layout); how it runs its
 * programs, and what they import, what its tau exposes, as the session's
 * registry entry has it, each in its folder in the box's /node_modules; and
 * leaves out the sections dsh writes for a person at the host, which are
 * false in a box, and the runtime context on the host's sandbox policy.
 * @module fleet-core/tau/prompt
 */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { AssembledSection } from '@deepseek-ai/dsh-system-prompt'
import { FOLDERS, PRIMER } from 'fleet-box-runtime/tau/layout'
import type { Entry } from './registry.ts'
import type {} from './runs-plugin.ts'

export const name = 'fleet-tau-prompt'
export const inject = ['systemPrompt', 'fleetTauRuns']

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

/** Where the model works, and what a tau is, which follow the persona. */
export const WHERE = `You work in a box of your own, a container, which your tools act on: bash and the file tools. Your working directory is ${FOLDERS.inout}. What a tau is, and what a run of one promises, is in ${PRIMER}.`

/** How the model runs its programs, and what they import, which follow where it works; nothing for a tau that exposes nothing. */
export function programs({ exposed, modules }: Pick<Entry, 'exposed' | 'modules'>): string {
  if (exposed.length === 0) return ''
  return [
    'Run your programs with `node`: JavaScript, or TypeScript that Node.js runs as is, stripping its types, so with no enums, namespaces or parameter properties. '
      + 'Wherever a program is in your box, it imports by name what your tau exposes, listed below. '
      + 'Before you call one, read its `package.json`, and the declarations its `types` names, in its folder. '
      + 'What an API does stays done when a program fails.',
    '',
    ...exposed.map(({ specifier, description }) => `- \`${specifier}\`, in ${posix.join(modules, specifier)}${description === undefined ? '' : `: ${description}`}`),
  ].join('\n')
}

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'fleet:tau-where',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
    text: WHERE,
  })
  // Prepended, so it sees the assembly once every other listener has had it.
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    const sessionId = agent?.session.header.id
    const text = sessionId === undefined || !ctx.fleetTauRuns.isTau(sessionId) ? '' : programs(await ctx.fleetTauRuns.entry(sessionId))
    // After where the model works; the tau's descriptions are its author's, not prompt variables.
    const added: AssembledSection[] = text === '' ? [] : [{ name: 'fleet:tau-programs', text, interpolate: false }]
    const sections = assembly.sections.filter(section => !HOST_SECTIONS.has(section.name))
    const where = sections.findIndex(section => section.name === 'fleet:tau-where') + 1
    return {
      ...assembly,
      sections: [...sections.slice(0, where), ...added, ...sections.slice(where)],
      contexts: assembly.contexts.filter(context => !HOST_CONTEXTS.has(context.name)),
    }
  }, { prepend: true })
}
