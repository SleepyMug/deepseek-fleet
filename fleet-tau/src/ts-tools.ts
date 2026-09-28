/**
 * The TypeScript tools a session's agents get when its spec asks for them
 * (./agent.ts): `ts_modules`, `ts_execute` and `ts_install`, as pi-run gives
 * its agents `listModules` and `execute`, with a system-prompt section on
 * how to use them. Each call starts fleet-box's runner in the session's
 * container through `ctx.subprocess`, so programs run there, never on the
 * host, and see what bash sees; the runner type-checks and runs them with
 * ts-executor (fleet-box/runner). Programs import the services the agent
 * declares as `@svc/<name>`, the modules it ships, and the packages
 * `ts_install` added to the container's package root.
 * @module fleet-tau/ts-tools
 */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { HELPER_NODE } from 'fleet-box/image'
import { MAX_REPLY_BYTES, RUNNER_ENTRY, TS_ROOT, isPackageSpec, type RunnerFailure, type RunnerReply, type RunnerRequest } from 'fleet-box/runner'
import { AGENT_VIEW, type Spec } from './spec.ts'

/** How long a program may run, type-checking included. */
const EXECUTE_TIMEOUT_MS = 120_000
/** How long an install may take. */
const INSTALL_TIMEOUT_MS = 300_000
/** Time the runner gets beyond its own deadline to report before the tool gives up on it. */
const REPORT_MARGIN_MS = 30_000
/** Time the runner gets to end its program once the call is cancelled. */
const GRACE_MS = 5000
/** Of stdout and stderr, the first and last this many characters each are kept (fleet-box/runner/report). */
const OUTPUT_KEPT = '16 Ki'

const INSTRUCTIONS = `# TypeScript programs

Besides running commands, you can write TypeScript programs and run them in this session's container with \`ts_execute\`. A program is one self-contained ES module that exports \`main(input)\`; it is type-checked strictly, then run in a fresh Node process. It imports, by package name:
- the services this session can call, as \`@svc/<name>\`. Their calls leave the container for services the fleet host provides;
- the modules this session's agent ships;
- packages you add from the npm registry with \`ts_install\`. They go into ${TS_ROOT}, which lasts as long as the container;
- Node's built-ins, as \`node:\` specifiers.

## Workflow

1. Call \`ts_modules({ query? })\` to list what programs can import. It gives each package's specifier, description and \`packageRoot\`, a folder in this container.
2. Read a package's \`package.json\` and the declaration files its \`types\` and \`exports\` name, under \`packageRoot\`, before writing calls; descriptions are summaries, not contracts. A package without declarations needs its \`@types/<name>\` package installed too.
3. Write strict ES2022 TypeScript with ESM imports.
4. Call \`ts_execute({ source, cwd?, input? })\`. It type-checks before running; fix the reported errors and retry. \`cwd\`, the session folder by default, is where relative paths resolve; packages are imported by specifier wherever it is.
5. Each run is a fresh process with fresh module state, and the processes it starts are killed when it ends; await all its work before \`main\` returns. Service calls are asynchronous, take and return JSON, may change state outside the container, and are not undone when a program fails.

## JSON

\`input\`, the value \`main\` returns, and the arguments of service calls must be strict JSON: null, booleans, finite numbers, strings, arrays and plain objects of these. Leave out an optional argument or property rather than passing \`undefined\`. A \`main\` that returns nothing gives null. Put the answer in the return value; stdout and stderr are logs.`

/**
 * Register the TypeScript tools and their instructions in an agent's scope.
 * @param ctx - the agent's scope, with `tools`, `subprocess` and `systemPrompt`.
 * @param spec - the session's spec, whose services and modules programs import.
 */
export function registerTsTools(ctx: Context, spec: Spec): void {
  const packages = (): Omit<Extract<RunnerRequest, { command: 'modules' }>, 'command'> => ({
    root: TS_ROOT,
    services: Object.entries(spec.services).map(([name, service]) => ({ name, ...service, functions: [...service.functions] })),
    modules: spec.modules.map(module => ({
      name: module.name,
      ...module.description === undefined ? {} : { description: module.description },
      root: posix.join(AGENT_VIEW, 'modules', module.dir),
    })),
  })

  ctx.systemPrompt.section({ name: 'fleet-tau:typescript', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') - 1, interpolate: false, text: INSTRUCTIONS })

  ctx.tools.register(defineTool({
    name: 'ts_modules',
    description: 'List the packages a `ts_execute` program may import: the services this session can call (`@svc/<name>`), the modules its agent ships, '
      + 'and the packages `ts_install` added. Returns each package\'s specifier, description and packageRoot, a folder in this container; '
      + 'read its package.json and declaration files to learn its API.',
    parameters: {
      query: { type: 'string', description: 'Case-insensitive filter on specifier and description.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          modules: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: { specifier: { type: 'string', required: true }, packageRoot: { type: 'string', required: true }, description: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.modules) }],
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const reply = await runner(ctx, exec, { command: 'modules', ...packages(), ...args.query === undefined ? {} : { query: args.query } })
      if (!('modules' in reply)) throw failed(reply)
      return { modules: reply.modules }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ts_execute',
    description: 'Type-check and run one TypeScript ES module in a fresh Node process in this session\'s container. It must export '
      + '`async function main(input)` returning JSON (returning nothing gives null); it may import the packages `ts_modules` lists. '
      + 'Returns { value, stdout, stderr, durationMs }; a type error or a failure is a tool error carrying the diagnostics and the output. '
      + `Of stdout and stderr, the first and last ${OUTPUT_KEPT} characters each are kept, and a large return value is shown as a preview, `
      + `so write large results to a file. The program is killed after ${EXECUTE_TIMEOUT_MS / 1000} s, type-checking included, `
      + 'and the processes it started are killed when it ends, unless they left its process group.',
    parameters: {
      source: { type: 'string', required: true, description: 'A complete TypeScript ES module exporting `main(input)`.' },
      cwd: { type: 'string', description: 'Absolute folder the program runs in; the session folder by default.' },
      input: { type: 'json', description: 'JSON value passed to main; left out, main gets undefined.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          value: { type: 'json', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    timeoutMs: EXECUTE_TIMEOUT_MS + REPORT_MARGIN_MS,
    async execute(args, exec) {
      const cwd = args.cwd ?? sessionFolder(exec)
      if (!posix.isAbsolute(cwd)) throw new Error('cwd must be an absolute folder')
      const reply = await runner(ctx, exec, {
        command: 'execute', ...packages(), source: args.source, cwd, timeoutMs: EXECUTE_TIMEOUT_MS, ...args.input === undefined ? {} : { input: args.input },
      })
      if (!('value' in reply)) throw failed(reply)
      // ts-executor returns JSON only; its type here is dsh's, as the tool's input is.
      const value = (reply.value ?? null) as Exclude<typeof args.input, undefined>
      return { value, stdout: reply.stdout, stderr: reply.stderr, durationMs: reply.durationMs }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ts_install',
    description: `Add packages from the npm registry to this session's TypeScript package root, ${TS_ROOT}, so \`ts_execute\` programs can import them. `
      + 'They stay while the container does. Returns each package\'s installed version and whether it brings type declarations; '
      + 'install `@types/<name>` for one that does not.',
    parameters: {
      packages: {
        type: 'array', required: true, items: { type: 'string' },
        description: 'Registry packages, each a name with an optional version, range or tag, such as `lodash@4` or `@types/lodash`.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          installed: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: { name: { type: 'string', required: true }, version: { type: 'string', required: true }, typed: { type: 'boolean', required: true } },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.installed.map(({ name, version, typed }) => `${name}@${version}${typed ? '' : ` (no type declarations; install @types/${name.replace(/^@([^/]+)\//u, '$1__')})`}`).join('\n'),
      }],
    },
    timeoutMs: INSTALL_TIMEOUT_MS + REPORT_MARGIN_MS,
    async execute(args, exec) {
      const refused = args.packages.filter(spec => !isPackageSpec(spec))
      if (args.packages.length === 0) throw new Error('name at least one package')
      if (refused.length > 0) throw new Error(`only registry packages can be installed, each a name with an optional version: ${refused.join(', ')}`)
      const reply = await runner(ctx, exec, { command: 'install', root: TS_ROOT, packages: args.packages, timeoutMs: INSTALL_TIMEOUT_MS })
      if (!('installed' in reply)) throw failed(reply)
      return { installed: reply.installed }
    },
  }))
}

/** Start the runner in the session's container for one request, and read its reply. */
async function runner(ctx: Context, exec: ToolRunContext, request: RunnerRequest): Promise<RunnerReply> {
  const handle = ctx.subprocess.spawn({
    argv: [HELPER_NODE, RUNNER_ENTRY],
    cwd: sessionFolder(exec),
    stdio: { stdin: { data: JSON.stringify(request) }, stdout: { maxBytes: 2 * MAX_REPLY_BYTES }, stderr: { maxBytes: 64 * 1024 } },
    graceMs: GRACE_MS,
    signal: exec.signal,
  } satisfies SubprocessSpawnSpec)
  const outcome = await handle.done
  exec.signal.throwIfAborted()
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  try {
    return JSON.parse(stdout) as RunnerReply
  } catch {
    const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
    const ended = outcome.signal === null ? `exit ${String(outcome.exitCode)}` : outcome.signal
    throw new Error(`the TypeScript runner failed (${ended})${stderr === '' ? '' : `: ${stderr.slice(-4096)}`}`)
  }
}

function sessionFolder(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) throw new Error('the TypeScript tools need a session with a folder')
  return cwd
}

/** A failed reply as a tool error, whose message is the failure as JSON, as pi-run reports one. */
function failed(reply: RunnerReply): Error {
  const failure: RunnerFailure = reply.ok ? { name: 'Error', message: 'the TypeScript runner answered something else' } : reply.error
  return new Error(JSON.stringify(failure))
}
