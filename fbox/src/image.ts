/**
 * The session image every container runs: its definition, what the world
 * relies on inside it, and how it is built. Building is a setup step of its
 * own, run by this package's `fleet-setup` command; fbox only looks the image
 * up when it starts.
 * @module fbox/image
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The image definition this package ships. */
export const IMAGE_DIR = fileURLToPath(new URL('../image/', import.meta.url))
/** This package's `fleet-setup` command, run as `node <path>` wherever the package is installed. */
export const SETUP_ENTRY = fileURLToPath(new URL('../bin.js', import.meta.url))
/**
 * The files the image is built from, relative to `IMAGE_DIR`. They are the
 * whole build context and all its tag digests, so a Dockerfile that uses any
 * other file fails to build instead of leaving the tag stale. The helper's
 * lockfile is an npm-shrinkwrap.json because packing drops package-lock.json.
 */
export const IMAGE_INPUTS: readonly string[] = ['Dockerfile', 'helper/npm-shrinkwrap.json', 'helper/package.json']
/** Where the Dockerfile installs Node and the dsh-ssh helper. */
export const HELPER_NODE = '/usr/local/bin/node'
export const HELPER_ENTRY = '/opt/fbox/helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js'

/** Prints the SHA-256 of the file named by its argument, as the helper's handshake computes it. */
const HASH_SCRIPT = 'process.stdout.write(require("node:crypto").createHash("sha256")'
  + '.update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))'

/** @returns the image's tag, a digest of its inputs. */
export async function imageTag(): Promise<string> {
  const digest = createHash('sha256')
  for (const file of IMAGE_INPUTS) digest.update(`${file}\0`).update(await readFile(join(IMAGE_DIR, file))).update('\0')
  return `fbox:${digest.digest('hex').slice(0, 12)}`
}

/** @returns the SHA-256 of the host's dsh-ssh helper; the image's copy must match it. */
export async function helperHash(): Promise<string> {
  const helper = await readFile(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-ssh/helper')))
  return createHash('sha256').update(helper).digest('hex')
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
 * Build this fbox's image unless its tag exists, then remove older
 * fbox tags. A new build must run the same dsh-ssh helper as the host,
 * or its tag is removed again. Docker refuses to remove a tag a container
 * still uses, so those stay until a later run finds them unused.
 * @returns the image's tag.
 */
export async function prepareImage(options: PrepareOptions): Promise<string> {
  const tag = await imageTag()
  if (await docker(options, ['image', 'inspect', '--format', '{{.Id}}', tag]).then(() => true, () => false)) {
    options.log(`fbox: ${tag} is already built`)
  } else {
    options.log(`fbox: building ${tag}`)
    await build(options, tag)
    const inImage = await docker(options, ['run', '--rm', '--network', 'none', '--entrypoint', HELPER_NODE, tag, '-e', HASH_SCRIPT, HELPER_ENTRY])
    if (inImage !== await helperHash()) {
      await docker(options, ['image', 'rm', tag])
      throw new Error('fbox: the image\'s dsh-ssh helper differs from the host\'s; pin the host\'s @deepseek-ai/dsh-ssh '
        + 'version in image/helper/package.json and its lockfile, then build again')
    }
    options.log(`fbox: built ${tag}`)
  }
  const others = (await docker(options, ['image', 'ls', '--filter', 'reference=fbox', '--format', '{{.Repository}}:{{.Tag}}']))
    .split('\n').filter(line => line !== '' && line !== tag)
  for (const older of others) {
    try {
      await docker(options, ['image', 'rm', older])
      options.log(`fbox: removed ${older}`)
    } catch {
      options.log(`fbox: kept ${older}, which a container still uses`)
    }
  }
  return tag
}

/** Send the inputs to `docker build` as a tar stream, so the context holds nothing else. */
async function build(options: PrepareOptions, tag: string): Promise<void> {
  const { signal } = options
  const tar = spawn('tar', ['-c', '-f', '-', '-C', IMAGE_DIR, '--', ...IMAGE_INPUTS], { stdio: ['ignore', 'pipe', 'inherit'], signal })
  const builder = spawn(options.docker, ['build', '--tag', tag, '-'], { stdio: ['pipe', 'inherit', 'inherit'], signal })
  tar.stdout.pipe(builder.stdin)
  await Promise.all([exited(tar, 'tar'), exited(builder, 'docker build')])
}

function exited(child: ChildProcess, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`fbox: ${name} failed (${signal ?? `exit ${String(code)}`})`))
    })
  })
}

/** @returns trimmed stdout; a failure carries Docker's stderr. */
function docker(options: PrepareOptions, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(options.docker, args, { signal: options.signal }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout.trim())
      else reject(new Error(`fbox: docker ${args[0] ?? ''} failed: ${stderr.trim() || error.message}`, { cause: error }))
    })
  })
}
