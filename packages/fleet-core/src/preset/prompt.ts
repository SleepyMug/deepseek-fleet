/**
 * fleet-tau-prompt, the system prompt of a tau's session, as a dsh plugin
 * that fleet-core's `tau` agent preset mounts, so it shapes only the prompts
 * of the sessions that preset makes: it tells the model where it works, its
 * box, its working directory there, /tau/workspace, and where tau's
 * TAU.md is, /tau/TAU.md (fleet-box-runtime/tau/layout); how it runs its
 * programs, from the tau's own directory, /tau/self, so that they resolve
 * as the tau's code does, and what they import, what its tau exposes, as
 * the session's registry entry has it; and
 * leaves out the sections dsh writes for a person at the host, which are
 * false in a box, and the runtime context on the host's sandbox policy.
 * It leaves out the host's tools, which every session has, such as
 * tau_run (../tools/tau.ts), since they work on the host: a tau's session
 * has its preset's tools alone, which work in its box, and runs taus with
 * its tau API.
 * @module @sleepymug/fleet-core/preset/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { AssembledSection } from '@deepseek-ai/dsh-system-prompt'
import { FOLDERS, PRIMER, SELF } from '@sleepymug/fleet-box-runtime/tau/layout'
import type {} from '../services.ts'
import type { TauBoxes } from '../tau/ports.ts'
import type { Entry } from '../tau/registry.ts'

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
export const WHERE = `You work in a box of your own, a container, which your tools act on: bash and the file tools. Your working directory is ${FOLDERS.inout}. What a TAU is, and what a run of one promises, is in ${PRIMER}.`

/** How the model runs its programs, and what they import, which follow where it works; nothing for a tau that exposes nothing. */
export function programs({ exposed }: Pick<Entry, 'exposed'>): string {
  if (exposed.length === 0) return ''
  return [
    `You can run programs with \`node\`, from the TAU's directory: \`cd ${SELF}; node - <<'EOF'\`, the program, then \`EOF\`. `
      + `This environment provides the modules below for them to import, resolving from ${SELF}. `
      + 'To understand a module\'s API, read its `package.json`, and the declarations its `types` names, in its folder.',
    '',
    ...exposed.map(({ specifier, description }) => `- \`${specifier}\`${description === undefined ? '' : `: ${description}`}`),
  ].join('\n')
}

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'fleet:tau-where',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
    text: WHERE,
  })
  const runs: TauBoxes = ctx.fleetTauRuns
  // Prepended, so it sees the assembly once every other listener has had it.
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    const sessionId = agent?.session.header.id
    const text = sessionId === undefined || !runs.isTau(sessionId) ? '' : programs(await runs.entry(sessionId))
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
  // Hidden from every agent of the preset, so from each tau's session, as each is registered: dsh mounts
  // the preset as it starts, maybe before tau_run's plugin, or another bundle's, registers its tool.
  ctx.inject(['tools'], (inner) => {
    const hidden = new Set<string>()
    const hide = (): void => {
      const names = inner.tools.schemas().map(({ name }) => name).filter(name => name !== RUN_CODE_NAME && !hidden.has(name))
      if (names.length === 0) return
      for (const name of names) hidden.add(name)
      inner.tools.restrict({ deny: names })
    }
    inner.on('tools/change', hide)
    hide()
  })
}
