/**
 * fleet-ts-tools, the TypeScript tools of a tau's session, as a dsh plugin
 * that fleet-core's `tau` agent preset mounts (docs/fleet-core/tools/index.md):
 * `ts_modules` lists what the tau exposes to its programs, its APIs and the
 * packages of its own built on them, and `ts_execute` type-checks one
 * program and runs it in the session's box, through its helper, with
 * ts-executor (fleet-image's helper/cmd/ts.ts). A program imports what the
 * box's /tau/node_modules holds, each API running its extension's client
 * (docs/fleet-core/ext/index.md).
 * @module fleet-core/tools/ts
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { MODULES } from '../tau/place.ts'
import type { Entry } from '../tau/registry.ts'
import type {} from '../tau/runs-plugin.ts'

export const name = 'fleet-ts-tools'
export const inject = ['tools', 'systemPrompt', 'fleetTauRuns']

/** Where a program's packages resolve from, and ts-executor makes its runs' folders: above /tau/node_modules. */
const ROOT = posix.dirname(MODULES)

const INSTRUCTIONS = `# TypeScript programs

Besides running commands, you can write TypeScript programs and run them in your box with \`ts_execute\`. A program is one self-contained ES module that exports \`main(input)\`; it is type-checked strictly, then run in a fresh Node process. It imports, by package name, what your tau exposes: its APIs, as \`@api/<name>\`, typed by their declarations, which may reach outside the box; and packages built on them. It imports Node's built-ins as \`node:\` specifiers.

1. Call \`ts_modules({ query? })\` to list what programs can import. It gives each package's specifier, description and \`packageRoot\`, a folder in your box.
2. Read a package's \`package.json\` and the declaration files its \`types\` names, under \`packageRoot\`, before writing calls; descriptions are summaries, not contracts.
3. Write strict ES2022 TypeScript with ESM imports.
4. Call \`ts_execute({ source, cwd?, input? })\`. It type-checks before running; fix the reported errors and retry. \`cwd\`, your working directory by default, is where relative paths resolve; packages are imported by name wherever it is.
5. Each run is a fresh process with fresh module state, and the processes it starts are killed when it ends; await all its work before \`main\` returns. What an API did is not undone when a program fails.

\`input\` and the value \`main\` returns are strict JSON: null, booleans, finite numbers, strings, arrays and plain objects of these. A \`main\` that returns nothing gives null. Put the answer in the return value; stdout and stderr are logs.`

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:ts',
    order: ctx.systemPrompt.getSectionOrder('TOOL_EDIT') + 50,
    interpolate: false,
    text: ({ scope }) => ctx.tools.get('ts_execute', scope) === undefined ? '' : INSTRUCTIONS,
  })

  /** The registry entry of the tau's session that makes the call. */
  const entryOf = async (exec: ToolExecution): Promise<Entry> => {
    const sessionId = exec.agent?.session.header.id
    if (sessionId === undefined || !ctx.fleetTauRuns.isTau(sessionId)) throw new Error('the TypeScript tools work only in a tau\'s session')
    return ctx.fleetTauRuns.entry(sessionId)
  }

  ctx.tools.register(defineTool({
    name: 'ts_modules',
    description: 'List the packages a `ts_execute` program may import: what your tau exposes, its APIs (`@api/<name>`) and packages built on them. '
      + 'Returns each package\'s specifier, description and packageRoot, a folder in your box; read its package.json and declaration files to learn its API.',
    parameters: {
      query: { type: 'string', description: 'Case-insensitive filter on specifier and description.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          modules: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { specifier: { type: 'string', required: true }, packageRoot: { type: 'string', required: true }, description: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.modules) }],
    },
    async execute(args, exec) {
      const query = args.query?.trim().toLowerCase() ?? ''
      const modules = modulesOf(await entryOf(exec))
        .filter(module => `${module.specifier}\n${module.description ?? ''}`.toLowerCase().includes(query))
        .map(({ specifier, root, description }) => ({ specifier, packageRoot: root, ...description === undefined ? {} : { description } }))
      return { modules }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ts_execute',
    description: 'Type-check and run one TypeScript ES module in a fresh Node process in your box. It must export `main(input)`, sync or async, '
      + 'returning JSON (returning nothing gives null); it may import the packages `ts_modules` lists. Returns { value, stdout, stderr, durationMs }; '
      + 'a type error or a failure is a tool error carrying the diagnostics and the output. The program runs until it returns, unless the call is '
      + 'cancelled; the processes it started are killed when it ends, unless they left its process group.',
    parameters: {
      source: { type: 'string', required: true, description: 'A complete TypeScript ES module exporting `main(input)`.' },
      cwd: { type: 'string', description: 'Absolute folder the program runs in; your working directory by default.' },
      input: { type: 'json', description: 'JSON value passed to main; left out, main gets undefined.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: { type: 'json', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const entry = await entryOf(exec)
      const cwd = args.cwd ?? exec.agent?.session.header.cwd ?? entry.project
      if (!posix.isAbsolute(cwd)) throw new Error('cwd must be an absolute folder')
      const box = await ctx.fleetTauRuns.boxFor(entry.sessionId)
      if (box === undefined) throw new Error(`${entry.sessionId} has no box`)
      const execution = randomUUID()
      const cancel = (): void => { box.request('ts.cancel', { execution }).catch(() => {}) }
      exec.signal.addEventListener('abort', cancel, { once: true })
      try {
        const outcome = await box.request('ts.execute', {
          execution,
          root: ROOT,
          modules: modulesOf(entry),
          source: args.source,
          cwd,
          ...args.input === undefined ? {} : { input: args.input },
        })
        exec.signal.throwIfAborted()
        if (!outcome.ok) throw new Error(JSON.stringify({ ...outcome.error, stdout: outcome.stdout, stderr: outcome.stderr }))
        // ts-executor returns JSON only; its type here is dsh's, as the tool's input is.
        const value = (outcome.value ?? null) as Exclude<typeof args.input, undefined>
        return { value, stdout: outcome.stdout, stderr: outcome.stderr, durationMs: outcome.durationMs }
      } finally {
        exec.signal.removeEventListener('abort', cancel)
      }
    },
  }))
}

/** What a tau's programs are told they import, each with its package's folder in the box. */
export function modulesOf(entry: Pick<Entry, 'exposed'>): { specifier: string; root: string; description?: string }[] {
  return entry.exposed.map(({ specifier, description }) => ({
    specifier,
    root: `${MODULES}/${specifier}`,
    ...description === undefined ? {} : { description },
  }))
}
