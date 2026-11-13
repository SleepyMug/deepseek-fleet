/**
 * One run of a scenario on a scratch gateway and dsh: a fleet home of its
 * own in a temporary folder, the checkout's `fleet serve` on it, with the
 * checkout's notes service registered; a dsh home of its own, whose profile
 * links this checkout's dsh-tau, and fleet-trace's driver (./driver.ts), and
 * routes the model to the scripted one (./model.ts); dsh itself, the
 * workspace's, started on a free port; there, a run of the tau, through the
 * gateway's tau service, which dsh-tau serves, as `tau run --adaptor rpc`
 * does it on the host, or a session given a prompt, as the web UI makes
 * one, through the driver's; and, once
 * it has ended, every run released, every box removed, dsh and the gateway
 * stopped and the temporary folder removed. What the model was sent is
 * left in the output folder: every request, and the last of the scenario's
 * conversation rendered (./render.ts); and how it ended, and the caller's
 * folder after it.
 * @module @sleepymug/fleet-trace/run
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createClient, type WireAdaptor } from '@sleepymug/tau'
import { createRpcAdaptor, rpcTransport } from '@sleepymug/tau/rpc'
import { tauPaths } from '@sleepymug/dsh-tau/paths'
import { Fleet } from '@sleepymug/fleet-sdk'
import type { Request, Settled } from './driver.ts'
import { ScriptedModel, type Script, type Step } from './model.ts'
import { render } from './render.ts'

/** A scenario file: the tau and its call, or a session's prompt; the caller's files; and what the model does. */
export interface Scenario {
  /** The tau's directory, relative to the scenario file; or, in its place, `prompt`. */
  tau?: string
  /** A prompt, given to a session as the web UI makes one, in the caller's folder, in place of a run of a tau. */
  prompt?: string
  /** The caller's folder: each file by its relative path, with its text. */
  files?: Record<string, string>
  /** The run's call, its files and args, as `tau start` takes them; relative paths are the caller's folder's. */
  call?: { files?: Record<string, string | string[] | { path: string | string[] }>; args?: Record<string, unknown> }
  /** The model's tool calls, in order, one per turn. */
  steps: Step[]
  /** The model's last answer, after the last step. */
  final: string
  /** What the model does in the runs the run or the session starts, each by a phrase of its prompt. */
  runs?: Script[]
}

/** This checkout. */
const CHECKOUT = fileURLToPath(new URL('../../../', import.meta.url))

/** The image the boxes run: $FLEET_TRACE_IMAGE, or the gateway's default. */
const IMAGE = process.env.FLEET_TRACE_IMAGE

/**
 * Run a scenario, and write what the model was sent to `out`, which is
 * emptied first.
 * @param signal - interrupts the run, which then cleans up as it does when it ends.
 */
export async function runScenario(scenarioFile: string, out: string, signal?: AbortSignal): Promise<void> {
  const scenario = JSON.parse(readFileSync(scenarioFile, 'utf8')) as Scenario
  if ((scenario.tau === undefined) === (scenario.prompt === undefined)) throw new Error('fleet-trace: a scenario has a tau, with its call, or a prompt')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'requests'), { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'fleet-trace-'))
  const home = join(scratch, 'home')
  const fleetHome = join(scratch, 'fleet')
  const fleetSock = join(fleetHome, 'fleet.sock')
  const work = join(scratch, 'work')
  const model = await ScriptedModel.start(scenario.steps, scenario.final, join(out, 'requests'), scenario.runs)
  let dsh: ChildProcess | undefined
  let fleet: ChildProcess | undefined
  let notes: ChildProcess | undefined
  let released = false
  try {
    await profile(home, model.port)
    const fleetLog = createWriteStream(join(out, 'fleet.log'))
    fleet = startNode(['packages/fleet/lib/cli/main.js', 'serve', ...IMAGE === undefined ? [] : ['--image', IMAGE]], fleetHome, fleetSock)
    fleet.stderr?.pipe(fleetLog, { end: false })
    await until(() => existsSync(fleetSock) || fleet?.exitCode !== null)
    if (!existsSync(fleetSock)) throw new Error(`fleet-trace: fleet serve exited; see ${join(out, 'fleet.log')}`)
    notes = startNode(['services/notes/lib/main.js', '--dir', join(fleetHome, 'notes')], fleetHome, fleetSock)
    notes.stderr?.pipe(fleetLog, { end: false })
    dsh = startDsh(home, fleetSock)
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
    const running = dsh
    // dsh is ready once its tau service is registered with the gateway, and its driver listens.
    const ready = async (): Promise<boolean> => existsSync(driverSocket(home)) && (await services(fleetSock)).includes('tau')
    await Promise.race([untilAsync(async () => await ready() || running.exitCode !== null || signal?.aborted === true), exited, interrupted])
    const runs = createRpcAdaptor({ transport: rpcTransport({ socket: fleetSock, path: '/services/tau' }), project: work })
    for (const [path, text] of Object.entries(scenario.files ?? {})) {
      mkdirSync(dirname(join(work, path)), { recursive: true })
      writeFileSync(join(work, path), text)
    }
    let result: unknown
    if (scenario.tau !== undefined) {
      const call = scenario.call ?? {}
      // The folder of each file's path, where an `out` goes.
      const paths = Object.values(call.files ?? {}).flatMap(file => typeof file === 'object' && !Array.isArray(file) ? file.path : file)
      for (const path of paths) mkdirSync(dirname(resolve(work, path)), { recursive: true })
      const client = createClient({ adaptors: { rpc: runs } })
      const run = await failing('start', client.start(resolve(dirname(scenarioFile), scenario.tau), call, { cwd: work }))
      const id = run.slice('rpc:'.length)
      model.prompt = promptOf(home, id).trim()
      // The run is released with the others, once its caller's folder is kept.
      const ended = await Promise.race([failing('finish', client.finish(run)), exited, interrupted])
      if (!ended.ok) process.stderr.write(`fleet-trace: the run failed: ${String(ended.failure)}\n`)
      result = ended
    } else {
      model.prompt = String(scenario.prompt).trim()
      result = await Promise.race([failing('session', drive(driverSocket(home), { project: work, prompt: String(scenario.prompt) })), exited, interrupted])
    }
    // How it ended, and the caller's folder with what it gave back.
    writeFileSync(join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    cpSync(work, join(out, 'work'), { recursive: true, verbatimSymlinks: true })
    await releaseRuns(fleetSock, runs)
    released = true
  } finally {
    if (!released && dsh?.exitCode === null) await releaseRuns(fleetSock, createRpcAdaptor({ transport: rpcTransport({ socket: fleetSock, path: '/services/tau' }) })).catch(() => {})
    if (dsh !== undefined) await stop(dsh)
    if (fleet?.exitCode === null) await removeBoxes(fleetSock).catch(() => {})
    if (notes !== undefined) await stop(notes)
    if (fleet !== undefined) await stop(fleet)
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
 * The profile of a scratch dsh home, `fleet`: dsh's base and web bundles,
 * as dsh's own `web` profile has them, then this checkout's dsh-tau, linked;
 * the driver, on its socket in the home; and the model routed to the
 * scripted one, installed with dsh's own `plugin`.
 */
async function profile(home: string, port: number): Promise<void> {
  const dir = join(home, 'profiles', 'fleet')
  mkdirSync(dir, { recursive: true })
  const packages = Object.fromEntries([join(CHECKOUT, 'packages', 'dsh-tau')].map(path => [packageName(path), path]))
  const trace = join(CHECKOUT, 'packages', 'fleet-trace')
  const manifest = {
    name: 'dsh-profile-fleet',
    private: true,
    dependencies: Object.fromEntries([...Object.entries(packages), [packageName(trace), trace]].map(([name, path]) => [name, `link:${path}`])),
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
    '      name: "@sleepymug/fleet-trace/driver"',
    `      config: { socket: ${JSON.stringify(driverSocket(home))} }`,
    '',
  ].join('\n'))
  await promisify(execFile)('pnpm', ['exec', 'dsh', 'plugin', '--profile', 'fleet', 'install'], { cwd: CHECKOUT, env: { ...process.env, DSH_HOME: home } })
}

/** The name in the package.json of the package at `path`. */
function packageName(path: string): string {
  return (JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as { name: string }).name
}

/** The workspace's dsh, in a process group of its own, so that stopping it stops pnpm and dsh both, on the gateway at `fleetSock`. */
function startDsh(home: string, fleetSock: string): ChildProcess {
  return spawn('pnpm', ['exec', 'dsh', '--profile', 'fleet', '--no-open', '--port', '0'], {
    cwd: CHECKOUT,
    env: { ...process.env, DSH_HOME: home, FLEET_SOCKET: fleetSock, FLEET_TRACE_KEY: 'scripted' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** A program of this checkout's, on this Node, in a process group of its own, with the fleet home and socket given. */
function startNode(argv: string[], fleetHome: string, fleetSock: string): ChildProcess {
  return spawn(process.execPath, argv, {
    cwd: CHECKOUT,
    env: { ...process.env, FLEET_HOME: fleetHome, FLEET_SOCKET: fleetSock },
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

/** Remove every box of the scratch gateway, whatever a run left. */
async function removeBoxes(fleetSock: string): Promise<void> {
  const client = await Fleet.connect({ socket: fleetSock })
  try {
    for (const box of await client.list()) await client.box(box.id).remove().catch(() => {})
  } finally {
    await client.close()
  }
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

/**
 * Release every run, each with the runs it started: each run's box says
 * its session, and the run that started it, in its labels.
 */
async function releaseRuns(fleetSock: string, runs: WireAdaptor): Promise<void> {
  const client = await Fleet.connect({ socket: fleetSock })
  try {
    const sessions = (await client.list()).flatMap(({ labels }) => labels['dsh.session'] === undefined ? [] : [{ id: labels['dsh.session'], parent: labels['tau.parent'] }])
    const known = new Set(sessions.map(session => session.id))
    for (const { id, parent } of sessions) {
      if (parent === undefined || !known.has(parent)) await failing('release', runs.release(id))
    }
  } finally {
    await client.close()
  }
}

/** The names of the services the gateway at `fleetSock` has registered now; none if it does not answer. */
async function services(fleetSock: string): Promise<string[]> {
  try {
    const client = await Fleet.connect({ socket: fleetSock })
    try {
      return (await client.serviceList()).map(service => service.name)
    } finally {
      await client.close()
    }
  } catch {
    return []
  }
}

/** A run's prompt, as dsh-tau's registry in the dsh home has it. */
function promptOf(home: string, sessionId: string): string {
  return String((JSON.parse(readFileSync(join(tauPaths(home, 'fleet-trace').runs, `${sessionId}.json`), 'utf8')) as { prompt?: unknown }).prompt)
}

/** What an op gives, its failure named. */
async function failing<T>(op: string, answer: Promise<T>): Promise<T> {
  return await answer.catch((error: unknown) => {
    throw new Error(`fleet-trace: ${op} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  })
}

/** Once `found` holds, checking every 200 ms. */
async function until(found: () => boolean): Promise<void> {
  while (!found()) await delay(200)
}

/** Once `found` holds, checking every 200 ms. */
async function untilAsync(found: () => Promise<boolean>): Promise<void> {
  while (!await found()) await delay(200)
}
