/**
 * `fleet setup image`: build the session image fleet-box uses, outside dsh,
 * as dsh-ssh's operator installs its helper on a host. The image is an
 * environment, fleet-image's Dockerfile's own or one the caller names, with
 * fleet's runtime on top: fleet-image, which holds fleet-box's helper,
 * fleet-tau's TypeScript runner, fleet's API implementations and the `tau`
 * command, copied with the packages it depends on as they are installed here
 * (./stage.ts), so the image runs what the host has installed. The helper
 * and the runner label the image with their protocols, which their users
 * check before starting them. A build is tagged only once its helper answers
 * its handshake, its runner answers a request, every implementation loads,
 * and the `tau` command answers, each where the host or the model will look
 * for it, so a tag always names a working image. Nothing is removed: the
 * build a new one untags is left for `docker image prune`, since a container
 * may still use it.
 * @module fleet-client/setup/image
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_IMAGE, HELPER_ENTRY, HELPER_NODE, PROTOCOL_LABEL, PROTOCOL_VERSION } from 'fleet-image/helper/image'
import { implementations } from 'fleet-image/apis/registry'
import { TAU_COMMAND } from 'fleet-image/layout'
import { RUNNER_ENTRY, RUNNER_PROTOCOL, RUNNER_PROTOCOL_LABEL, TS_ROOT, type RunnerRequest } from 'fleet-image/runner/protocol'
import { installedPackage, stagePackage } from './stage.ts'

/** This package's folder, from which fleet-image is found as Node finds it. */
const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url))
/** How long a new build's helper and runner get to answer. */
const CHECK_TIMEOUT_MS = 60_000

/** Docker reports Go's architecture names; the packages were chosen by Node's. */
const NODE_ARCH: Record<string, string> = {
  amd64: 'x64', arm64: 'arm64', arm: 'arm', 386: 'ia32', ppc64le: 'ppc64', s390x: 's390x', riscv64: 'riscv64', loong64: 'loong64',
}

/** The package the image holds, with the Dockerfile that copies it from the build context's fleet/. */
const RUNTIME = 'fleet-image'
/** The protocols of its helper and its runner, which their users check before starting them. */
const LABELS: Record<string, string> = { [PROTOCOL_LABEL]: String(PROTOCOL_VERSION), [RUNNER_PROTOCOL_LABEL]: String(RUNNER_PROTOCOL) }

export interface BuildOptions {
  /** Docker CLI executable. */
  docker: string
  /** The environment the runtime is installed on; the Dockerfile's own when left out. */
  from?: string
  /** What to tag the build; fleet-box's `image` setting names it. */
  tag: string
  /** Receives one line per step; Docker's own build output goes to this process's stdout and stderr. */
  log: (line: string) => void
  /** Stops the Docker processes. */
  signal?: AbortSignal
}

/**
 * Build the image, check it, and tag it.
 * @returns the image's id.
 */
export async function buildImage(options: BuildOptions): Promise<string> {
  await dockerResponds(options)
  const reported = await docker(options, ['version', '--format', '{{.Server.Arch}}'])
  const work = await mkdtemp(join(tmpdir(), 'fleet-setup-image-'))
  try {
    const context = join(work, 'context')
    await mkdir(context, { recursive: true })
    const runtime = await installedPackage(PACKAGE_DIR, RUNTIME)
    await copyFile(join(runtime, 'Dockerfile'), join(context, 'Dockerfile'))
    await stagePackage(runtime, join(context, 'fleet'), NODE_ARCH[reported] ?? reported)
    options.log(`fleet: building the session image${options.from === undefined ? '' : ` on ${options.from}`}`)
    const id = await build(options, context, join(work, 'id'))
    await checkHelper(options, id)
    await checkRunner(options, id)
    await checkImplementations(options, id)
    await checkTauCommand(options, id)
    const earlier = await docker(options, ['image', 'inspect', '--format', '{{.Id}}', options.tag]).catch(() => undefined)
    await docker(options, ['tag', id, options.tag])
    options.log(`fleet: built ${options.tag} (${short(id)})`)
    if (earlier !== undefined && earlier !== id) {
      options.log(`fleet: the earlier ${options.tag} (${short(earlier)}) is untagged now; \`docker image prune\` removes it once no container uses it`)
    }
    if (options.tag !== DEFAULT_IMAGE) {
      options.log(`fleet: fleet-box uses ${DEFAULT_IMAGE} unless its row in the profile's patch sets \`image: ${options.tag}\``)
    }
    return id
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** Fail early and plainly when the Docker daemon is not reachable, rather than on a build step. */
function dockerResponds(options: BuildOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(options.docker, ['version', '--format', '{{.Server.Version}}'], { signal: options.signal }, (error, _stdout, stderr) => {
      if (error === null) resolve()
      else reject(new Error(`fleet: Docker does not respond; start it and run \`fleet setup image\` again: ${stderr.trim() || error.message}`))
    })
  })
}

/** @returns the id of the image built, untagged. */
async function build(options: BuildOptions, context: string, idFile: string): Promise<string> {
  const args = [
    // A provenance attestation records when it was built, which gives an unchanged build a new id, and so recreates every container.
    'build', '--provenance=false', '--iidfile', idFile,
    ...options.from === undefined ? [] : ['--build-arg', `ENVIRONMENT=${options.from}`],
    ...Object.entries(LABELS).flatMap(([name, value]) => ['--label', `${name}=${value}`]),
    context,
  ]
  const builder = spawn(options.docker, args, { stdio: ['ignore', 'inherit', 'inherit'], signal: options.signal })
  await exited(builder, 'docker build')
  return (await readFile(idFile, 'utf8')).trim()
}

/** Start the build's helper without a network and check that it answers in this protocol. */
async function checkHelper(options: BuildOptions, id: string): Promise<void> {
  const hello = `${JSON.stringify({ type: 'request', id: 1, method: 'hello', params: {} })}\n`
  // Its stdin ending stops the helper, and with it the container, so it ends only once the answer is in.
  const { stdout, stderr, late } = await probe(options, id, HELPER_NODE, ['--disable-sigusr1', HELPER_ENTRY], hello, 'answer')
  const line = stdout.split('\n', 1)[0] ?? ''
  let protocol: unknown
  try {
    protocol = (JSON.parse(line) as { value?: { protocol?: unknown } }).value?.protocol
  } catch {
    protocol = undefined
  }
  if (protocol !== PROTOCOL_VERSION) throw failure(id, 'helper did not answer its handshake', late, stderr)
}

/**
 * Start the build's runner without a network and check that it lists what a
 * program may import.
 */
async function checkRunner(options: BuildOptions, id: string): Promise<void> {
  const request: RunnerRequest = { command: 'modules', root: TS_ROOT, apis: [] }
  // The runner reads its request to the end of its stdin.
  const { stdout, stderr, late } = await probe(options, id, HELPER_NODE, [RUNNER_ENTRY], JSON.stringify(request), 'input')
  let reply: { ok?: unknown; modules?: unknown } | null
  try {
    reply = JSON.parse(stdout) as typeof reply
  } catch {
    reply = null
  }
  if (reply?.ok !== true || !Array.isArray(reply.modules)) throw failure(id, 'TypeScript runner did not answer', late, stderr || stdout)
}

/** Check that every implementation of an API loads in the build, as a program's process imports it. */
async function checkImplementations(options: BuildOptions, id: string): Promise<void> {
  const images = implementations().map(({ image }) => image)
  const code = `for (const module of ${JSON.stringify(images)}) await import(module); console.log('loaded')`
  const { stdout, stderr, late } = await probe(options, id, HELPER_NODE, ['--input-type=module', '--eval', code], '', 'input')
  if (stdout.trim() !== 'loaded') throw failure(id, 'API implementations did not load', late, stderr || stdout)
}

/** Check that the `tau` command runs in the build, as the model's commands find it. */
async function checkTauCommand(options: BuildOptions, id: string): Promise<void> {
  const { stdout, stderr, late } = await probe(options, id, TAU_COMMAND, ['--help'], '', 'input')
  if (!stdout.startsWith('Usage: tau run')) throw failure(id, '`tau` command did not answer', late, stderr || stdout)
}

function failure(id: string, what: string, late: boolean, output: string): Error {
  const within = late ? ` within ${CHECK_TIMEOUT_MS / 1000} s` : ''
  return new Error(`fleet: the ${what}${within} in the new build ${short(id)}, which is left untagged${output.trim() === '' ? '' : `: ${output.trim()}`}`)
}

/**
 * Run a program in a throwaway container of the image, without a network,
 * with `input` on its stdin, which closes once the input is written, or
 * once the program has answered with a line.
 */
async function probe(
  options: BuildOptions, id: string, program: string, args: string[], input: string, close: 'input' | 'answer',
): Promise<{ stdout: string; stderr: string; late: boolean }> {
  const child = spawn(options.docker, ['run', '--rm', '--interactive', '--network', 'none', '--entrypoint', program, id, ...args],
    { stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal })
  // A program that failed to start closes its stdin; its stderr explains why.
  child.stdin.on('error', () => {})
  let late = false
  const timer = setTimeout(() => {
    late = true
    child.stdin.end()
    child.kill('SIGKILL')
  }, CHECK_TIMEOUT_MS)
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    if (close === 'answer' && stdout.includes('\n')) child.stdin.end()
  })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  child.stdin.write(input)
  if (close === 'input') child.stdin.end()
  await exited(child, [program, ...args].join(' ')).catch(() => {})
  clearTimeout(timer)
  return { stdout, stderr, late }
}

function short(id: string): string {
  return id.replace(/^sha256:/u, '').slice(0, 12)
}

function exited(child: ChildProcess, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      if (child.exitCode === 0) resolve()
      else reject(new Error(`fleet: ${name} failed (${child.signalCode ?? `exit ${String(child.exitCode)}`})`))
      return
    }
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`fleet: ${name} failed (${signal ?? `exit ${String(code)}`})`))
    })
  })
}

/** @returns trimmed stdout; a failure carries Docker's stderr. */
function docker(options: BuildOptions, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(options.docker, args, { signal: options.signal }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout.trim())
      else reject(new Error(`fleet: docker ${args[0] ?? ''} failed: ${stderr.trim() || error.message}`, { cause: error }))
    })
  })
}
