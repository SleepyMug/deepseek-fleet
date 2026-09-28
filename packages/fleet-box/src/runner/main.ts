/**
 * fleet-box's TypeScript runner, which fleet-tau's `ts_*` tools start in a
 * session container for each call, with the helper's own Node:
 * `/opt/fleet-box/bin/fleet-box /opt/fleet-box/runner/main.js`, one JSON
 * request on stdin, one JSON reply on stdout (./protocol.ts). It runs
 * programs with ts-executor, so each one is type-checked and runs in a fresh
 * Node process of its own, and it imports:
 * - each service the agent declares as `@svc/<name>`, whose calls go to
 *   fleet-box's service socket at $TAU_SOCKET, and from there to the host;
 * - each module the agent ships, by its package name;
 * - each package `install` added to the package root, by its name.
 *
 * A SIGTERM, which the host sends when a call is cancelled or runs out of
 * time, ends the program, and every process in its process group, before
 * the runner exits.
 * @module fleet-box/runner/main
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ExecutionAbortedError, TSFuncExecutor, hostModule, packageModule, type HostModule, type JsonValue } from '@sleepymug/ts-executor'
import { isPackageSpec, packageName, type Installed, type ModuleSummary, type RunnerReply, type RunnerRequest } from './protocol.ts'
import { OutputCapture, capText, outputCaptures, replyLine, reportFailure, reportResult } from './report.ts'
import { callService } from './tau-client.ts'

type Packages = Extract<RunnerRequest, { command: 'modules' | 'execute' }>

/** Characters of npm's output an install reports. */
const INSTALL_LOG_CHARS = 8 * 1024
/** Time npm gets to stop once asked to. */
const NPM_GRACE_MS = 2000

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
    case 'install': return install(request)
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
 * An executor over the package root with every package a program may import
 * registered, for one operation; the service modules it wrote are removed after.
 */
async function withExecutor(request: Packages, operation: (executor: TSFuncExecutor) => Promise<RunnerReply>): Promise<RunnerReply> {
  await ensureRoot(request.root)
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
    const taken = new Set(request.services.map(service => `@svc/${service.name}`))
    for (const module of request.modules) {
      taken.add(module.name)
      executor.modules.register(packageModule({ specifier: module.name, root: module.root, ...module.description === undefined ? {} : { description: module.description } }))
    }
    for (const module of await installedPackages(request.root)) {
      if (taken.has(module.name)) continue
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
async function servicePackages(request: Packages): Promise<Map<string, string>> {
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

/** The package root, with a package.json of its own for npm to add to. */
async function ensureRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  const manifest = join(root, 'package.json')
  if (!existsSync(manifest)) await writeFile(manifest, `${JSON.stringify({ private: true, description: 'Packages installed with ts_install' }, null, 2)}\n`)
}

/** The packages the root's package.json depends on and node_modules holds, but not type packages, which nothing imports. */
async function installedPackages(root: string): Promise<{ name: string; root: string; description?: string }[]> {
  let dependencies: Record<string, unknown>
  try {
    dependencies = (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> }).dependencies ?? {}
  } catch {
    return []
  }
  const packages: { name: string; root: string; description?: string }[] = []
  for (const name of Object.keys(dependencies).sort()) {
    if (name.startsWith('@types/')) continue
    const folder = join(root, 'node_modules', name)
    const manifest = await readManifest(folder)
    if (manifest === undefined) continue
    packages.push({ name, root: folder, ...typeof manifest.description === 'string' ? { description: manifest.description } : {} })
  }
  return packages
}

/** Add packages to the root with npm, and say what each one is now. */
async function install(request: Extract<RunnerRequest, { command: 'install' }>): Promise<RunnerReply> {
  const refused = request.packages.filter(spec => !isPackageSpec(spec))
  if (request.packages.length === 0 || refused.length > 0) {
    return { ok: false, error: { name: 'TypeError', message: request.packages.length === 0 ? 'name at least one package' : `not a registry package: ${refused.join(', ')}` } }
  }
  await ensureRoot(request.root)
  const log = new OutputCapture(INSTALL_LOG_CHARS)
  const outcome = await npm(['install', '--no-audit', '--no-fund', '--no-update-notifier', '--save', ...request.packages], request.root, log, request.timeoutMs)
  if (outcome !== 0) {
    const reason = outcome === 'timeout' ? `npm ran longer than ${request.timeoutMs / 1000} s and was stopped` : `npm install failed (${outcome})`
    return { ok: false, error: { name: 'InstallError', message: reason, stderr: log.text() } }
  }
  const installed: Installed[] = []
  for (const name of request.packages.map(packageName)) {
    const manifest = await readManifest(join(request.root, 'node_modules', name))
    const version = typeof manifest?.version === 'string' ? manifest.version : 'unknown'
    installed.push({ name, version, typed: manifest !== undefined && await typed(request.root, name, manifest) })
  }
  return { ok: true, installed, log: capText(log.text(), INSTALL_LOG_CHARS) }
}

/**
 * Run npm in its own process group, its output into `log`.
 * @returns its exit code, `timeout`, or the signal that ended it.
 */
function npm(args: string[], cwd: string, log: OutputCapture, timeoutMs: number): Promise<number | string> {
  return new Promise((resolve) => {
    const child = spawn('npm', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    child.stdout.setEncoding('utf8').on('data', log.push)
    child.stderr.setEncoding('utf8').on('data', log.push)
    let timedOut = false
    const stop = (): void => {
      const group = child.pid
      if (group === undefined) return
      try {
        process.kill(-group, 'SIGTERM')
      } catch {}
      setTimeout(() => { try { process.kill(-group, 'SIGKILL') } catch {} }, NPM_GRACE_MS).unref()
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    cancelled.signal.addEventListener('abort', stop, { once: true })
    child.once('error', (error) => {
      clearTimeout(timer)
      log.push(`${error.message}\n`)
      resolve(`could not start npm: ${error.message}`)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve(timedOut ? 'timeout' : code ?? signal ?? 'unknown')
    })
  })
}

/** Whether a package brings type declarations, of its own or as its `@types/` package. */
async function typed(root: string, name: string, manifest: Record<string, unknown>): Promise<boolean> {
  if (typeof manifest.types === 'string' || typeof manifest.typings === 'string') return true
  if (JSON.stringify(manifest.exports ?? null).includes('"types"')) return true
  if (existsSync(join(root, 'node_modules', name, 'index.d.ts'))) return true
  const typesName = name.startsWith('@') ? name.slice(1).replace('/', '__') : name
  return existsSync(join(root, 'node_modules', '@types', typesName, 'package.json'))
}

async function readManifest(folder: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function summary(module: { specifier: string; packageRoot: string; description?: string }): ModuleSummary {
  return { specifier: module.specifier, packageRoot: module.packageRoot, ...module.description === undefined ? {} : { description: module.description } }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
