/**
 * fleet-tau-prompt, the system prompt of a tau's session, as a dsh plugin
 * that fleet-core's `tau` agent preset mounts, so it shapes only the prompts
 * of the sessions that preset makes. It tells the model where it works: its
 * box, its working directory there, /tau/workspace, and the tau's own
 * directory, /tau/self (fleet-box-runtime/tau/layout); how its run ends, and
 * what its caller gets; and where tau's TAU.md and TAU_DEV.md are. For each
 * session, as its registry entry has it, it lists the run's files, each
 * with its mode, its kind, where the box has it and what `tau.json` says
 * it is; and says how the model runs its programs, from the tau's own
 * directory, so that they resolve as the tau's code does, and what they
 * import, what its tau exposes, each with where it is declared.
 *
 * It leaves out the sections and runtime contexts dsh writes for a person
 * at the host, which are false in a box, and dsh's identity, which the
 * persona says in its place; gives bash a description of what it does in
 * a box, in place of dsh's, which is the host's; says once what write and
 * edit each say, that a file is read first; and hides the skill tool from a
 * session whose tau has no skills. It leaves out the host's tools, which
 * every session has, such as tau_run (../tools/tau.ts), since they work on
 * the host: a tau's session has its preset's tools alone, which work in its
 * box, and runs taus with its tau API. And it shadows the skills of tau's
 * primers, which every session has (../tools/primers.ts), with skills the
 * model cannot load: a tau's session reads the primers in its box.
 * @module @sleepymug/fleet-core/preset/prompt
 */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-skill'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { AssembledSection, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { DEV_PRIMER, FOLDERS, PRIMER, SELF } from '@sleepymug/fleet-box-runtime/tau/layout'
import type {} from '../services.ts'
import type { TauBoxes } from '../tau/ports.ts'
import type { Entry } from '../tau/registry.ts'
import { PRIMERS } from '../tools/primers.ts'

export const name = 'fleet-tau-prompt'
export const inject = ['systemPrompt', 'fleetTauRuns', 'skills']

/**
 * dsh's sections about the host, by name: the harness's identity, which the
 * persona says in its place, its checkout on the host, the web GUI at its
 * URL, the web UI's file cards and links, and `@` mentions as paths on it.
 */
export const HOST_SECTIONS: ReadonlySet<string> = new Set([
  'harness:identity',
  'harness:source',
  'app:web-surface',
  'ui:deliverable-file-references',
  'context:file-reference',
])

/**
 * dsh's runtime contexts about the host, by name: the sandbox policy, full
 * access, which is the host's file policy, not the box's; and the approval
 * policy, which asks the model not to widen a sandbox the box does not have.
 */
export const HOST_CONTEXTS: ReadonlySet<string> = new Set([
  'sandbox:policy',
  'approval:policy',
])

/** Where the model works, how its run ends, and where tau's primers are, which follow the persona. */
export const WHERE = 'You work in a container of your own, as root, with network access: bash and the file tools act on it, '
  + `and it has Node.js, npm, git, python3 and curl. Your working directory is ${FOLDERS.inout}. The TAU's own directory, ${SELF}, `
  + 'holds its tau.json and what else it brings: read it, but do not change it.\n\n'
  + 'No one answers you during the run, so finish the task on your own. When you stop, the run ends, and your last message is the text '
  + 'your caller gets: make it your answer, and say there if you could not do the task. Your caller gets that text, what you leave at '
  + 'your out and inout files, and what your API calls did; anything else you write is discarded with the container.\n\n'
  + `${PRIMER} says what a TAU takes, and what a run of one promises, and ${DEV_PRIMER} how to make one: `
  + `read ${PRIMER} before you run a TAU yourself.`

/** What write and edit each say, once: their tools refuse to change a file the model has not read. */
export const READ_FIRST = 'Read an existing file before you overwrite it with write or change it with edit, unless you wrote or edited it '
  + 'since; prefer edit for targeted changes.'

/** What bash does in a box, in place of dsh's description, which is the host's. */
export const BASH = 'Run a bash command (`bash -c`) in your container, and return its stdout and stderr. Each call runs in a fresh shell, '
  + `in ${FOLDERS.inout} unless you pass \`workdir\`, so a \`cd\` lasts for its call alone. A command runs until it ends, so do not run `
  + 'one that waits for input or serves, or pass `timeoutMs`. Long output is truncated to its tail: write it to a file and read that '
  + 'instead. Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a '
  + 'computed path you have not checked. An unset variable expands to an empty string, so guard variables in such paths with `${VAR:?}`.'

/** What bash's `timeoutMs` does in a box. */
export const BASH_TIMEOUT = 'Kill the command after this many milliseconds; without it, the command runs until it ends.'

/** The run's files, each with its mode, its kind, its place and what it is; nothing for a run without files, or an entry without places. */
export function files({ files }: Pick<Entry, 'files'>): string {
  const all = Object.entries(files)
  if (all.length === 0 || all.some(([, file]) => file.place === undefined)) return ''
  const kinds = { file: 'a file', dir: 'a directory' }
  const has = (test: (file: Entry['files'][string]) => boolean): boolean => all.some(([, file]) => test(file))
  const rules = [
    ...has(file => file.mode === 'in') ? ['An in file is a copy of your caller\'s, for you to read.'] : [],
    ...has(file => file.mode !== 'in')
      ? ['Leave a file or a directory, as each out and inout file\'s kind says, at its place, or the run fails, and your caller gets none of them.']
      : [],
    ...has(file => file.mode !== 'in' && file.kind !== 'file') ? ['A directory you leave merges into your caller\'s: what you remove from it stays there.'] : [],
  ]
  return [
    'Your files:',
    '',
    ...all.map(([name, { mode, kind, place, description }]) =>
      `- \`${name}\`, ${mode}, ${kind === undefined ? 'a file or a directory' : kinds[kind]}, at ${String(place)}${description === undefined ? '' : `: ${description}`}`),
    '',
    rules.join(' '),
  ].join('\n')
}

/** How the model runs its programs, and what they import, each with where it is declared; nothing for a tau that exposes nothing. */
export function programs({ exposed }: Pick<Entry, 'exposed'>): string {
  if (exposed.length === 0) return ''
  return [
    `Run programs with bash's \`node\`, \`workdir\` ${SELF}, so that their imports resolve as the TAU's code does: \`node - <<'EOF'\`, `
      + 'the program, then `EOF`. Write JavaScript, or TypeScript that Node.js runs as is, its types stripped, without `enum` or `namespace`. '
      + `Give a program absolute paths, such as your files' places, since its working directory is ${SELF}. `
      + 'It can import the modules below; read what one declares before you use it.',
    '',
    ...exposed.map(({ specifier, description }) => `- \`${specifier}\`, ${declared(specifier)}${description === undefined ? '' : `: ${description}`}`),
  ].join('\n')
}

/** Where the model reads what a module declares: an API's in the tau's copy of its contract, a package of the tau's own as it says. */
function declared(specifier: string): string {
  return specifier.startsWith('@api/')
    ? `declared in ${posix.join(SELF, 'api', specifier.slice('@api/'.length), 'index.d.ts')}`
    : `in ${posix.join(SELF, 'node_modules', specifier)}, whose package.json names its declarations`
}

/** The prompt of a session, as dsh assembled it, as it is in a box; for a tau's session, as its entry has the run. */
export function boxed(assembly: PromptAssembly, entry: Pick<Entry, 'files' | 'exposed' | 'skills'> | undefined): PromptAssembly {
  const added: AssembledSection[] = entry === undefined ? [] : [
    // The tau's descriptions are its author's, not prompt variables.
    { name: 'fleet:tau-files', text: files(entry), interpolate: false },
    { name: 'fleet:tau-programs', text: programs(entry), interpolate: false },
  ].filter(section => section.text !== '')
  const merged = assembly.sections.some(section => section.name === 'tool:write') && assembly.sections.some(section => section.name === 'tool:edit')
  const sections = assembly.sections
    .filter(section => !HOST_SECTIONS.has(section.name) && !(merged && section.name === 'tool:edit'))
    .map(section => merged && section.name === 'tool:write' ? { ...section, text: READ_FIRST } : section)
  // After where the model works.
  const where = sections.findIndex(section => section.name === 'fleet:tau-where') + 1
  return {
    ...assembly,
    sections: [...sections.slice(0, where), ...added, ...sections.slice(where)],
    contexts: assembly.contexts.filter(context => !HOST_CONTEXTS.has(context.name)),
    tools: assembly.tools
      .filter(tool => tool.name !== 'skill' || entry?.skills === undefined || entry.skills.length > 0)
      .map(tool => tool.name === 'bash' ? bash(tool) : tool),
  }
}

/** bash, described as it is in a box. */
function bash(tool: PromptAssembly['tools'][number]): PromptAssembly['tools'][number] {
  const properties = (tool.parameters.properties ?? {}) as Record<string, Record<string, unknown>>
  const { timeoutMs } = properties
  return {
    ...tool,
    description: BASH,
    parameters: { ...tool.parameters, properties: timeoutMs === undefined ? properties : { ...properties, timeoutMs: { ...timeoutMs, description: BASH_TIMEOUT } } },
  }
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
    return boxed(assembly, sessionId === undefined || !runs.isTau(sessionId) ? undefined : await runs.entry(sessionId))
  }, { prepend: true })
  // In the preset's layer, so they win over the host's, for its agents alone.
  for (const { name, description } of PRIMERS) {
    ctx.skills.register({ name, description, source: 'runtime', content: '', invocation: { modelInvocable: false, userInvocable: false } })
  }
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
