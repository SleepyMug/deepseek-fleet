/**
 * fleet-tau-prompt, the system prompt of a tau's session, as a dsh plugin
 * that fleet-core's `tau` agent preset mounts, so it shapes only the prompts
 * of the sessions that preset makes: it tells the model where it works, its
 * box and the run's folders there (./place.ts), and leaves out the sections
 * dsh writes for a person at the host, which are false in a box.
 * @module fleet-core/tau/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { FOLDERS, SELF } from './place.ts'

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

/** Where the model works, which follows the persona. */
export const WHERE = `You work in a box of your own, a container, which your tools act on: bash, the file tools, and your TypeScript programs. The run's things are in /tau:
- ${FOLDERS.in}: what you were given to read
- ${FOLDERS.inout}: what you were given to change in place
- ${FOLDERS.out}: where you leave what you are asked to write
- ${SELF}: the tau itself, its prompt and what it declares, to read but not change

Your working directory is {{cwd}}, a folder of the box, empty when you start.`

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'fleet:tau-where',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
    text: WHERE,
  })
  // Prepended, so it sees the assembly once every other listener has had it.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    return { ...assembly, sections: assembly.sections.filter(section => !HOST_SECTIONS.has(section.name)) }
  }, { prepend: true })
}
