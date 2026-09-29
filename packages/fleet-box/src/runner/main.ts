/**
 * fleet-box's TypeScript runner, which fleet-tau's `ts_*` tools start in a
 * session container for each call, with the helper's own Node:
 * `/opt/fleet-box/bin/fleet-box /opt/fleet-box/runner/main.js`, one JSON
 * request on stdin, one JSON reply on stdout (./protocol.ts). It runs
 * programs with ts-executor, so each one is type-checked and runs in a fresh
 * Node process of its own, and it imports:
 * - each service the agent declares as `@svc/<name>`, whose calls go to
 *   fleet-box's service socket at $TAU_SOCKET, and from there to the host;
 * - each module the agent ships, by its package name.
 *
 * A SIGTERM, which the host sends when a call is cancelled or runs out of
 * time, ends the program, and every process in its process group, before
 * the runner exits.
 * @module fleet-box/runner/main
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ExecutionAbortedError, TSFuncExecutor, hostModule, packageModule, type HostModule, type JsonValue } from '@sleepymug/ts-executor'
import type { ModuleSummary, RunnerReply, RunnerRequest } from './protocol.ts'
import { outputCaptures, replyLine, reportFailure, reportResult } from './report.ts'
import { callService } from './tau-client.ts'

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
      const readable = await servicePackages(request)
      return { ok: true, modules: listed.map(module => ({ ...summary(module), packageRoot: readable.get(module.specifier) ?? module.packageRoot })) }
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

/**
 * An executor over the TypeScript root with every package a program may
 * import registered, for one operation; the service modules it wrote are
 * removed after.
 */
async function withExecutor(request: RunnerRequest, operation: (executor: TSFuncExecutor) => Promise<RunnerReply>): Promise<RunnerReply> {
  await mkdir(request.root, { recursive: true })
  const executor = new TSFuncExecutor({ resolutionRoot: request.root })
  const services: HostModule[] = []
  try {
    const socket = process.env.TAU_SOCKET
    for (const service of request.services) {
      const module = await hostModule({
        resolutionRoot: request.root,
        specifier: `@svc/${service.name}`,
        ...service.description === undefined ? {} : { description: service.description },
        declarations: service.declarations,
        functions: service.functions,
        call: async (fn, args, { signal }) => {
          if (socket === undefined || socket === '') throw new Error(`${service.name}.${fn}: TAU_SOCKET is not set, so no service can be reached`)
          return await callService(socket, service.name, fn, args, signal) as JsonValue
        },
      })
      services.push(module)
      executor.modules.register(module)
    }
    for (const module of request.modules) {
      executor.modules.register(packageModule({ specifier: module.name, root: module.root, ...module.description === undefined ? {} : { description: module.description } }))
    }
    return await operation(executor)
  } finally {
    await Promise.allSettled(services.map(module => module.dispose()))
  }
}

/**
 * A copy of each service's package to read, at `<root>/svc/<name>`, since
 * the one ts-executor imports is written for one run and removed after it.
 * @returns each service's folder, by specifier.
 */
async function servicePackages(request: RunnerRequest): Promise<Map<string, string>> {
  const folders = new Map<string, string>()
  for (const service of request.services) {
    const folder = join(request.root, 'svc', service.name)
    await mkdir(folder, { recursive: true })
    const manifest = { name: `@svc/${service.name}`, ...service.description === undefined ? {} : { description: service.description }, types: './index.d.ts' }
    await writeFile(join(folder, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(join(folder, 'index.d.ts'), service.declarations)
    folders.set(`@svc/${service.name}`, folder)
  }
  return folders
}

function summary(module: { specifier: string; packageRoot: string; description?: string }): ModuleSummary {
  return { specifier: module.specifier, packageRoot: module.packageRoot, ...module.description === undefined ? {} : { description: module.description } }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
