/**
 * The session image every container runs: its definition, what the world
 * relies on inside it, and how it is built. The build owns the helper and the
 * TypeScript runner: it compiles their sources and installs them, with their
 * dependencies and a Node of their own, under /opt/fleet-box. Building is a setup step of its
 * own, run by `fleet-setup image` from the fleet-setup package; fleet-box only
 * looks the image up when it starts.
 * @module fleet-box/image
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from './helper/protocol.ts'

/** This package's folder, the root of the build context. */
export const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url))
const DOCKERFILE = 'image/Dockerfile'
/** How long a newly built helper gets to answer its handshake. */
const CHECK_TIMEOUT_MS = 60_000
/** The helper's and the runner's TypeScript sources, which the image build compiles. */
const HELPER_SOURCES = 'src/helper'
const RUNNER_SOURCES = 'src/runner'
/**
 * The runner's dependency on @sleepymug/ts-executor, packed from the linked
 * checkout by scripts/stage-runner.mjs until that version is on npm.
 */
const RUNNER_VENDOR = 'image/runner/vendor/sleepymug-ts-executor-0.4.0.tgz'
/**
 * The helper's Node, a copy of the image's, so a Node the model installs or
 * removes does not change it. The helper names its process `fleet-box`, so a
 * `pkill node` misses it too.
 */
export const HELPER_NODE = '/opt/fleet-box/bin/fleet-box'
export const HELPER_ENTRY = '/opt/fleet-box/helper/main.js'

/**
 * The files the image is built from, relative to {@link PACKAGE_DIR}. They
 * are the whole build context and all its tag digests, so a build that needs
 * any other file fails instead of leaving the tag stale. The helper's lockfile
 * is an npm-shrinkwrap.json because packing drops package-lock.json.
 */
export async function imageInputs(): Promise<string[]> {
  const sources = async (folder: string): Promise<string[]> =>
    (await readdir(join(PACKAGE_DIR, folder))).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')).sort().map(name => `${folder}/${name}`)
  await access(join(PACKAGE_DIR, RUNNER_VENDOR)).catch(() => {
    throw new Error(`fleet-box: ${RUNNER_VENDOR} is missing; stage it from the linked ts-executor checkout with \`node ${join(PACKAGE_DIR, 'scripts', 'stage-runner.mjs')}\``)
  })
  return [
    DOCKERFILE, 'image/helper/npm-shrinkwrap.json', 'image/helper/package.json', 'image/helper/tsconfig.json',
    ...await sources(HELPER_SOURCES),
    'image/runner/npm-shrinkwrap.json', 'image/runner/package.json', 'image/runner/tsconfig.json', RUNNER_VENDOR,
    ...await sources(RUNNER_SOURCES),
  ]
}

/** @returns the image's tag, a digest of its inputs. */
export async function imageTag(): Promise<string> {
  const digest = createHash('sha256')
  for (const file of await imageInputs()) digest.update(`${file}\0`).update(await readFile(join(PACKAGE_DIR, file))).update('\0')
  return `fleet-box:${digest.digest('hex').slice(0, 12)}`
}

export interface PrepareOptions {
  /** Docker CLI executable. */
  docker: string
  /** Receives one line per step; Docker's own build output goes to this process's stdout and stderr. */
  log: (line: string) => void
  /** Stops the Docker and tar processes. */
  signal?: AbortSignal
}

/**
 * Build this fleet-box's image unless its tag exists, then remove older
 * fleet-box tags. A new build must start its helper, or its tag is removed
 * again. Docker refuses to remove a tag a container still uses, so those stay
 * until a later run finds them unused.
 * @returns the image's tag.
 */
export async function prepareImage(options: PrepareOptions): Promise<string> {
  const tag = await imageTag()
  if (await docker(options, ['image', 'inspect', '--format', '{{.Id}}', tag]).then(() => true, () => false)) {
    options.log(`fleet-box: ${tag} is already built`)
  } else {
    options.log(`fleet-box: building ${tag}`)
    await build(options, tag)
    try {
      await checkHelper(options, tag)
    } catch (error) {
      await docker(options, ['image', 'rm', tag]).catch(() => {})
      throw error
    }
    options.log(`fleet-box: built ${tag}`)
  }
  const others = (await docker(options, ['image', 'ls', '--filter', 'reference=fleet-box', '--format', '{{.Repository}}:{{.Tag}}']))
    .split('\n').filter(line => line !== '' && line !== tag)
  for (const older of others) {
    try {
      await docker(options, ['image', 'rm', older])
      options.log(`fleet-box: removed ${older}`)
    } catch {
      options.log(`fleet-box: kept ${older}, which a container still uses`)
    }
  }
  return tag
}

/** Send the inputs to `docker build` as a tar stream, so the context holds nothing else. */
async function build(options: PrepareOptions, tag: string): Promise<void> {
  const { signal } = options
  const inputs = await imageInputs()
  const tar = spawn('tar', ['-c', '-f', '-', '-C', PACKAGE_DIR, '--', ...inputs], { stdio: ['ignore', 'pipe', 'inherit'], signal })
  const builder = spawn(options.docker, ['build', '--file', DOCKERFILE, '--tag', tag, '-'], { stdio: ['pipe', 'inherit', 'inherit'], signal })
  tar.stdout.pipe(builder.stdin)
  await Promise.all([exited(tar, 'tar'), exited(builder, 'docker build')])
}

/** Start the built helper without a network and check that it answers in this protocol. */
async function checkHelper(options: PrepareOptions, tag: string): Promise<void> {
  const args = ['run', '--rm', '--interactive', '--network', 'none', '--entrypoint', HELPER_NODE, tag, '--disable-sigusr1', HELPER_ENTRY]
  const child = spawn(options.docker, args, { stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal })
  // A helper that failed to start closes its stdin; its stderr explains why.
  child.stdin.on('error', () => {})
  // Its stdin ending stops the helper, and with it the container.
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
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const answered = new Promise<string>((resolve) => {
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.includes('\n')) resolve(stdout.slice(0, stdout.indexOf('\n')))
    })
    child.once('close', () => { resolve(stdout) })
  })
  child.stdin.write(`${JSON.stringify({ type: 'request', id: 1, method: 'hello', params: {} })}\n`)
  const line = await answered
  child.stdin.end()
  await exited(child, 'the helper check').catch(() => {})
  clearTimeout(timer)
  let protocol: unknown
  try {
    protocol = (JSON.parse(line) as { value?: { protocol?: unknown } }).value?.protocol
  } catch {
    protocol = undefined
  }
  if (protocol !== PROTOCOL_VERSION) {
    const within = late ? ` within ${CHECK_TIMEOUT_MS / 1000} s` : ''
    throw new Error(`fleet-box: the helper in ${tag} did not answer its handshake${within}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`)
  }
}

function exited(child: ChildProcess, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      if (child.exitCode === 0) resolve()
      else reject(new Error(`fleet-box: ${name} failed (${child.signalCode ?? `exit ${String(child.exitCode)}`})`))
      return
    }
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`fleet-box: ${name} failed (${signal ?? `exit ${String(code)}`})`))
    })
  })
}

/** @returns trimmed stdout; a failure carries Docker's stderr. */
function docker(options: PrepareOptions, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(options.docker, args, { signal: options.signal }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout.trim())
      else reject(new Error(`fleet-box: docker ${args[0] ?? ''} failed: ${stderr.trim() || error.message}`, { cause: error }))
    })
  })
}
