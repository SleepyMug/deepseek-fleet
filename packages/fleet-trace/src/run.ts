/**
 * One run of a scenario on a scratch fleet host: a dsh home of its own in a
 * temporary folder, whose fleet profile links this checkout's fleet-core and
 * extensions, and fleet-trace's driver (./driver.ts), and routes the model
 * to the scripted one (./model.ts); dsh itself, the workspace's, started on
 * a free port; there, a run of the tau, through the tau service's socket, as
 * `fleet run` does it, or a session given a prompt, as the web UI makes one,
 * through the driver's; and, once it has ended, every run deleted, dsh
 * stopped and the temporary folder removed. What the model was sent is left
 * in the output folder: every request, and the last of the scenario's
 * conversation rendered (./render.ts); and how it ended, and the caller's
 * folder after it.
 * @module fleet-trace/run
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ask as askService, type Body } from 'fleet-client/connection'
import { finishRun, startRun } from 'fleet-client/runs'
import { socketPath, type Answers } from 'fleet-protocol/tau'
import type { Request, Settled } from './driver.ts'
import { ScriptedModel, type Script, type Step } from './model.ts'
import { render } from './render.ts'

/** A scenario file: the tau and its values, or a session's prompt; the caller's files; and what the model does. */
export interface Scenario {
  /** The tau's directory, relative to the scenario file; or, in its place, `prompt`. */
  tau?: string
  /** A prompt, given to a session as the web UI makes one, in the caller's folder, in place of a run of a tau. */
  prompt?: string
  /** The caller's folder: each file by its relative path, with its text. */
  files?: Record<string, string>
  /** The run's values, as `fleet start` sends them; relative paths are the caller's folder's. */
  values?: Record<string, unknown>
  /** The model's tool calls, in order, one per turn. */
  steps: Step[]
  /** The model's last answer, after the last step. */
  final: string
  /** What the model does in the runs the run or the session starts, each by a phrase of its prompt. */
  runs?: Script[]
}

/** This checkout. */
const CHECKOUT = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * Run a scenario, and write what the model was sent to `out`, which is
 * emptied first.
 * @param signal - interrupts the run, which then cleans up as it does when it ends.
 */
export async function runScenario(scenarioFile: string, out: string, signal?: AbortSignal): Promise<void> {
  const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8')) as Scenario
  if ((scenario.tau === undefined) === (scenario.prompt === undefined)) throw new Error('fleet-trace: a scenario has a tau, with its values, or a prompt')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'requests'), { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'fleet-trace-'))
  const home = join(scratch, 'home')
  const work = join(scratch, 'work')
  const model = await ScriptedModel.start(scenario.steps, scenario.final, join(out, 'requests'), scenario.runs)
  let dsh: ChildProcess | undefined
  let deleted = false
  try {
    await profile(home, model.port)
    dsh = startDsh(home)
    const exited = new Promise<never>((_, reject) => {
      dsh?.once('exit', (code, signal) => { reject(new Error(`fleet-trace: dsh exited (${signal ?? `exit ${String(code)}`}); see ${join(out, 'dsh.log')}`)) })
    })
    exited.catch(() => {})
    const interrupted = new Promise<never>((_, reject) => {
      if (signal?.aborted === true) reject(new Error('fleet-trace: interrupted'))
      signal?.addEventListener('abort', () => { reject(new Error('fleet-trace: interrupted')) }, { once: true })
    })
    interrupted.catch(() => {})
    const log = createWriteStream(join(out, 'dsh.log'))
    dsh.stdout?.pipe(log, { end: false })
    dsh.stderr?.pipe(log, { end: false })
    const socket = socketPath(home)
    const running = dsh
    const ready = (): boolean => existsSync(socket) && existsSync(driverSocket(home))
    await Promise.race([until(() => ready() || running.exitCode !== null || signal?.aborted === true), exited, interrupted])
    for (const [path, text] of Object.entries(scenario.files ?? {})) {
      mkdirSync(dirname(join(work, path)), { recursive: true })
      writeFileSync(join(work, path), text)
    }
    let result: unknown
    if (scenario.tau !== undefined) {
      const values = scenario.values ?? {}
      for (const path of outPaths(values)) mkdirSync(dirname(resolve(work, path)), { recursive: true })
      const started = await failing('start', startRun(socket, resolve(dirname(scenarioFile), scenario.tau), values, work))
      model.prompt = started.prompt.trim()
      const ended = await Promise.race([failing('finish', finishRun(socket, started.sessionId)), exited, interrupted])
      if (!ended.ok) process.stderr.write(`fleet-trace: the run failed: ${String(ended.failure)}\n`)
      result = ended
    } else {
      model.prompt = String(scenario.prompt).trim()
      result = await Promise.race([failing('session', drive(driverSocket(home), { project: work, prompt: String(scenario.prompt) })), exited, interrupted])
    }
    // How it ended, and the caller's folder with what it gave back.
    writeFileSync(join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    cpSync(work, join(out, 'work'), { recursive: true, verbatimSymlinks: true })
    await deleteRuns(socket)
    deleted = true
  } finally {
    if (!deleted && dsh?.exitCode === null) await deleteRuns(socketPath(home)).catch(() => {})
    if (dsh !== undefined) await stop(dsh)
    await model.close()
    rmSync(scratch, { recursive: true, force: true })
  }
  const last = model.requests.filter(found => found.run).at(-1)
  if (last === undefined && scenario.tau !== undefined) {
    // Its tau's init did the run, so it has how it ended and what it gave back alone.
    process.stderr.write('fleet-trace: the run made no request of the model, as when its tau\'s init does the run\n')
    return
  }
  if (last === undefined) throw new Error('fleet-trace: the model had no request of the scenario\'s conversation')
  render(JSON.parse(readFileSync(last.file, 'utf8')) as Parameters<typeof render>[0], out)
}

/**
 * The fleet profile of a scratch dsh home: this checkout's fleet-core and
 * every extension in ext/, linked, after dsh's base and web bundles; the
 * driver, on its socket in the home; and the model routed to the scripted
 * one, installed with dsh's own `plugin`.
 */
async function profile(home: string, port: number): Promise<void> {
  const dir = join(home, 'profiles', 'fleet')
  mkdirSync(dir, { recursive: true })
  const exts = readdirSync(join(CHECKOUT, 'ext')).filter(name => existsSync(join(CHECKOUT, 'ext', name, 'package.json')))
  const packages: Record<string, string> = { 'fleet-core': join(CHECKOUT, 'packages', 'fleet-core') }
  for (const name of exts) packages[name] = join(CHECKOUT, 'ext', name)
  const manifest = {
    name: 'dsh-profile-fleet',
    private: true,
    dependencies: Object.fromEntries([...Object.entries(packages), ['fleet-trace', join(CHECKOUT, 'packages', 'fleet-trace')]].map(([name, path]) => [name, `link:${path}`])),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...Object.keys(packages)] } },
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config: { provider: mock, model: mock-model }',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      mock:',
    '        apiKeyEnv: FLEET_TRACE_KEY',
    '        api: openai-completions',
    `        baseURL: http://127.0.0.1:${String(port)}/v1`,
    '        models: [{ id: mock-model, name: Mock, contextWindow: 200000, input: [text, image] }]',
    '- insert:',
    '    - id: fleet-trace-driver',
    '      name: fleet-trace/driver',
    `      config: { socket: ${JSON.stringify(driverSocket(home))} }`,
    '',
  ].join('\n'))
  await promisify(execFile)('pnpm', ['exec', 'dsh', 'plugin', '--profile', 'fleet', 'install'], { cwd: CHECKOUT, env: { ...process.env, DSH_HOME: home } })
}

/** The workspace's dsh, in a process group of its own, so that stopping it stops pnpm and dsh both. */
function startDsh(home: string): ChildProcess {
  return spawn('pnpm', ['exec', 'dsh', '--profile', 'fleet', '--no-open', '--port', '0'], {
    cwd: CHECKOUT,
    env: { ...process.env, DSH_HOME: home, FLEET_TRACE_KEY: 'scripted' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function stop(dsh: ChildProcess): Promise<void> {
  if (dsh.exitCode !== null || dsh.signalCode !== null || dsh.pid === undefined) return
  const exit = new Promise((resolve) => { dsh.once('exit', resolve) })
  process.kill(-dsh.pid, 'SIGTERM')
  await exit
}

/** Where the driver listens, in a dsh home. */
function driverSocket(home: string): string {
  return join(home, 'fleet-trace.sock')
}

/** Have the driver make a session, give it a prompt, and wait until its agent is done. */
function drive(socket: string, request: Request): Promise<Settled> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket)
    let text = ''
    connection.setEncoding('utf8')
    connection.on('connect', () => { connection.write(`${JSON.stringify(request)}\n`) })
    connection.on('data', (chunk: string) => { text += chunk })
    connection.on('error', reject)
    connection.on('end', () => {
      try {
        const reply = JSON.parse(text) as { ok?: Settled; error?: string }
        if (reply.ok === undefined) reject(new Error(reply.error ?? 'the driver gave no answer'))
        else resolve(reply.ok)
      } catch {
        reject(new Error('the driver\'s answer is not JSON'))
      }
    })
  })
}

/** Delete every run, each with the runs it started. */
async function deleteRuns(socket: string): Promise<void> {
  const runs = await ask(socket, { op: 'list' })
  const known = new Set(runs.map(run => run.sessionId))
  for (const run of runs) if (run.parent === undefined || !known.has(run.parent)) await ask(socket, { op: 'delete', sessionId: run.sessionId })
}

/** One request to the tau service, whose failure throws. */
function ask<O extends Body['op']>(socket: string, body: Body & { op: O }): Promise<Answers[O]> {
  return failing(body.op, askService<O>(socket, body))
}

/** What an op gives, its failure named. */
async function failing<T>(op: string, answer: Promise<T>): Promise<T> {
  return await answer.catch((error: unknown) => {
    throw new Error(`fleet-trace: ${op} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  })
}

/** Each `$out` handle's path in a run's values, at any depth. */
function outPaths(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []
  if (typeof (value as { $out?: unknown }).$out === 'string') return [(value as { $out: string }).$out]
  return Object.values(value).flatMap(outPaths)
}

/** Once `found` holds, checking every 200 ms. */
async function until(found: () => boolean): Promise<void> {
  while (!found()) await delay(200)
}
