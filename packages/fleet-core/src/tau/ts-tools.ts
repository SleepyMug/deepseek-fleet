/**
 * The TypeScript tools the agents of every session the `fleet` command
 * started get (./agent.ts): `ts_modules` and `ts_execute`, as pi-run gives
 * its agents `listModules` and `execute`, with a system-prompt section on
 * how to use them. Each call starts the runner (fleet-image's runner/), which
 * the session image carries, in the session's container through
 * `ctx.subprocess`, so programs run there, never on the host, and see what
 * bash sees; the runner type-checks and runs them with ts-executor. Programs
 * import each API the agent declares as `@api/<name>`, typed by the agent's
 * declarations in its snapshot and running fleet's implementation, which
 * the image carries (fleet-image's apis/).
 * @module fleet-core/tau/ts-tools
 */

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { HELPER_NODE } from 'fleet-image/helper/image'
import { implementation } from 'fleet-image/apis/registry'
import type {} from '../box/world.ts'
import {
  MAX_REPLY_BYTES, RUNNER_ENTRY, RUNNER_PROTOCOL, RUNNER_PROTOCOL_LABEL, TS_ROOT, type RunnerFailure, type RunnerReply, type RunnerRequest,
} from 'fleet-image/runner/protocol'
import { parseRunnerReply } from './runner-reply.ts'
import { AGENT_VIEW } from './paths.ts'
import type { Spec } from './spec.ts'

/** Time the runner gets to end its program once the call is cancelled. */
const GRACE_MS = 5000
/** Of stdout and stderr, the first and last this many characters each are kept (fleet-image's runner/report.ts). */
const OUTPUT_KEPT = '16 Ki'

const INSTRUCTIONS = `# TypeScript programs

Besides running commands, you can write TypeScript programs and run them in this session's container with \`ts_execute\`. A program is one self-contained ES module that exports \`main(input)\`; it is type-checked strictly, then run in a fresh Node process. It imports, by package name:
- the APIs this session's agent declares, as \`@api/<name>\`, typed by the agent's declarations. Some run in the program alone; others reach the fleet host, outside the container;
- Node's built-ins, as \`node:\` specifiers.

## Workflow

1. Call \`ts_modules({ query? })\` to list what programs can import. It gives each package's specifier, description and \`packageRoot\`, a folder in this container.
2. Read a package's \`package.json\` and the declaration files its \`types\` and \`exports\` name, under \`packageRoot\`, before writing calls; descriptions are summaries, not contracts.
3. Write strict ES2022 TypeScript with ESM imports.
4. Call \`ts_execute({ source, cwd?, input? })\`. It type-checks before running; fix the reported errors and retry. \`cwd\`, your working directory by default, is where relative paths resolve; packages are imported by specifier wherever it is.
5. Each run is a fresh process with fresh module state, and the processes it starts are killed when it ends; await all its work before \`main\` returns. What an API does outside the container is not undone when a program fails.

## JSON

\`input\` and the value \`main\` returns must be strict JSON: null, booleans, finite numbers, strings, arrays and plain objects of these. Leave out an optional property rather than setting it to \`undefined\`. A \`main\` that returns nothing gives null. Put the answer in the return value; stdout and stderr are logs. APIs take and give what their declarations say.`

/**
 * Register the TypeScript tools and their instructions in an agent's scope.
 * @param ctx - the agent's scope, with `tools`, `subprocess` and `systemPrompt`.
 * @param spec - the session's spec, whose APIs programs import.
 */
export function registerTsTools(ctx: Context, spec: Spec): void {
  const packages = (): Omit<Extract<RunnerRequest, { command: 'modules' }>, 'command'> => ({
    root: TS_ROOT,
    apis: spec.apis.map(api => ({
      name: api.name,
      ...api.description === undefined ? {} : { description: api.description },
      types: posix.join(AGENT_VIEW, 'api', `${api.name}.d.ts`),
      implementation: implementationIn(api.name),
    })),
  })

  ctx.systemPrompt.section({ name: 'fleet-tau:typescript', order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') - 1, interpolate: false, text: INSTRUCTIONS })

  ctx.tools.register(defineTool({
    name: 'ts_modules',
    description: 'List the packages a `ts_execute` program may import: the APIs of this session\'s agent (`@api/<name>`). '
      + 'Returns each package\'s specifier, description and packageRoot, a folder in this container; read its package.json and declaration files to learn its API.',
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
      + 'so write large results to a file. The program runs until it returns, however long that takes, unless the call is cancelled; '
      + 'the processes it started are killed when it ends, unless they left its process group.',
    parameters: {
      source: { type: 'string', required: true, description: 'A complete TypeScript ES module exporting `main(input)`.' },
      cwd: { type: 'string', description: 'Absolute folder the program runs in; your working directory by default.' },
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
    async execute(args, exec) {
      const cwd = args.cwd ?? fleetCwd(exec)
      if (!posix.isAbsolute(cwd)) throw new Error('cwd must be an absolute folder')
      const reply = await runner(ctx, exec, {
        command: 'execute', ...packages(), source: args.source, cwd, ...args.input === undefined ? {} : { input: args.input },
      })
      if (!('value' in reply)) throw failed(reply)
      // ts-executor returns JSON only; its type here is dsh's, as the tool's input is.
      const value = (reply.value ?? null) as Exclude<typeof args.input, undefined>
      return { value, stdout: reply.stdout, stderr: reply.stderr, durationMs: reply.durationMs }
    },
  }))
}

/**
 * Start the runner in the session's container for one request, and read its
 * reply, once the image's label says it speaks this protocol.
 */
async function runner(ctx: Context, exec: ToolRunContext, request: RunnerRequest): Promise<RunnerReply> {
  const protocol = (await ctx.fleetBox.imageLabels())[RUNNER_PROTOCOL_LABEL]
  if (protocol !== String(RUNNER_PROTOCOL)) {
    throw new Error(`the session image's TypeScript runner speaks protocol ${protocol ?? 'none'}, not ${RUNNER_PROTOCOL}; rebuild it with \`pnpm image\` in the fleet checkout`)
  }
  const handle = ctx.subprocess.spawn({
    argv: [HELPER_NODE, RUNNER_ENTRY],
    cwd: fleetCwd(exec),
    stdio: { stdin: { data: JSON.stringify(request) }, stdout: { maxBytes: 2 * MAX_REPLY_BYTES }, stderr: { maxBytes: 64 * 1024 } },
    graceMs: GRACE_MS,
    signal: exec.signal,
  } satisfies SubprocessSpawnSpec)
  const outcome = await handle.done
  exec.signal.throwIfAborted()
  const reply = parseRunnerReply(handle.collected.stdout?.readFrom(0).text ?? '')
  if (reply !== undefined) return reply
  const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
  const ended = outcome.signal === null ? `exit ${String(outcome.exitCode)}` : outcome.signal
  throw new Error(`the TypeScript runner failed or answered something else (${ended})${stderr === '' ? '' : `: ${stderr.slice(-4096)}`}`)
}

/** The session's working folder in its container: the workspace dir, which fleet-box mounts at its own path, or a run's own folder. */
function fleetCwd(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined) throw new Error('the TypeScript tools need a session with a working directory')
  return cwd
}

/** A failed reply as a tool error, whose message is the failure as JSON, as pi-run reports one. */
function failed(reply: RunnerReply): Error {
  const failure: RunnerFailure = reply.ok ? { name: 'Error', message: 'the TypeScript runner answered something else' } : reply.error
  return new Error(JSON.stringify(failure))
}

/** Where the image holds fleet's implementation of an API the spec links. */
function implementationIn(name: string): string {
  const found = implementation(name)
  // The spec was stored only once fleet's implementation fitted the API.
  if (found === undefined) throw new Error(`fleet no longer implements the API ${name}`)
  return found.image
}
