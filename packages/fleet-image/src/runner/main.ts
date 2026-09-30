/**
 * fleet-tau's TypeScript runner, which its `ts_*` tools (fleet-tau's
 * ts-tools.ts) start in a session container for each call, with fleet-box's
 * helper Node: `/opt/fleet-box/bin/fleet-box /opt/fleet-box/runner/main.js`, one
 * JSON request on stdin, one JSON reply on stdout (./protocol.ts). The
 * session image carries it: `fleet-setup image` installs this package there
 * with the packages it depends on, as they are installed on the host.
 * It runs programs with ts-executor, so each one is type-checked and runs in
 * a fresh Node process of its own, and it imports each API the agent
 * declares as `@api/<name>`, typed by the agent's declarations and running
 * fleet's implementation, which the image carries (./links.ts). An
 * implementation runs in the program's process, and calls the host through
 * fleet-box's service socket, if at all, itself.
 *
 * A SIGTERM, which the host sends when a call is cancelled or runs out of
 * time, ends the program, and every process in its process group, before
 * the runner exits.
 * @module fleet-image/runner/main
 */

import { mkdir } from 'node:fs/promises'
import { ExecutionAbortedError, TSFuncExecutor, packageModule, type JsonValue } from '@sleepymug/ts-executor'
import { API_SCOPE, linkApi, linkNodeTypes } from './links.ts'
import type { ModuleSummary, RunnerReply, RunnerRequest } from './protocol.ts'
import { outputCaptures, replyLine, reportFailure, reportResult } from './report.ts'

const cancelled = new AbortController()
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { cancelled.abort(new Error(`the runner got ${signal}`)) })

let reply: RunnerReply
try {
  reply = await run(JSON.parse(await readStdin()) as RunnerRequest)
} catch (error) {
  reply = { ok: false, error: reportFailure(error, undefined, 0, false) }
}
process.stdout.write(`${replyLine(reply)}\n`, () => { process.exit(0) })

async function run(request: RunnerRequest): Promise<RunnerReply> {
  switch (request.command) {
    case 'modules': return withExecutor(request, async (executor) => {
      const listed = await executor.listModules(request.query === undefined ? {} : { query: request.query })
      return { ok: true, modules: listed.map(summary) }
    })
    case 'execute': return withExecutor(request, executor => execute(executor, request))
  }
}

async function execute(executor: TSFuncExecutor, request: Extract<RunnerRequest, { command: 'execute' }>): Promise<RunnerReply> {
  const deadline = AbortSignal.timeout(request.timeoutMs)
  const output = outputCaptures()
  try {
    const result = await executor.execute({
      source: request.source,
      cwd: request.cwd,
      // Tool arguments arrive as parsed JSON, so a present input is a JSON value.
      ...request.input === undefined ? {} : { input: request.input as JsonValue },
      check: true,
      signal: AbortSignal.any([cancelled.signal, deadline]),
      onStdout: output.stdout.push,
      onStderr: output.stderr.push,
    })
    return reportResult(result.value, result.durationMs, output)
  } catch (error) {
    const timedOut = error instanceof ExecutionAbortedError && deadline.aborted && !cancelled.signal.aborted
    return { ok: false, error: reportFailure(error, output, request.timeoutMs, timedOut) }
  }
}

/** An executor over the TypeScript root with each of the agent's APIs linked and registered, for one operation. */
async function withExecutor(request: RunnerRequest, operation: (executor: TSFuncExecutor) => Promise<RunnerReply>): Promise<RunnerReply> {
  await mkdir(request.root, { recursive: true })
  await linkNodeTypes(request.root)
  const executor = new TSFuncExecutor({ resolutionRoot: request.root })
  for (const api of request.apis) {
    const root = await linkApi(request.root, api)
    executor.modules.register(packageModule({ specifier: `${API_SCOPE}${api.name}`, root, ...api.description === undefined ? {} : { description: api.description } }))
  }
  return await operation(executor)
}

function summary(module: { specifier: string; packageRoot: string; description?: string }): ModuleSummary {
  return { specifier: module.specifier, packageRoot: module.packageRoot, ...module.description === undefined ? {} : { description: module.description } }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
