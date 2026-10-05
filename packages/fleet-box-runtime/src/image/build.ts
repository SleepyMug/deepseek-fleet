/**
 * Building the box image: this package's Dockerfile, with the package
 * staged beside it as it would be packed, with every package it depends on
 * as installed here (./stage.ts). Build the package first.
 * @module fleet-box-runtime/image/build
 */

import { execFile, spawn } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DEFAULT_IMAGE } from '../layout.ts'
import { stagePackage } from './stage.ts'

/** This package's folder. */
const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url))

/** Docker reports Go's architecture names; the packages were chosen by Node's. */
const NODE_ARCH: Record<string, string> = {
  amd64: 'x64', arm64: 'arm64', arm: 'arm', 386: 'ia32', ppc64le: 'ppc64', s390x: 's390x', riscv64: 'riscv64', loong64: 'loong64',
}

export interface BuildOptions {
  /** Docker CLI executable; `docker` by default. */
  docker?: string
  /** What to tag the build; {@link DEFAULT_IMAGE} by default. */
  tag?: string
}

/** Build the image and tag it; Docker's output goes to this process's stdout and stderr. */
export async function buildImage(options: BuildOptions = {}): Promise<void> {
  const docker = options.docker ?? 'docker'
  const tag = options.tag ?? DEFAULT_IMAGE
  const context = await mkdtemp(join(tmpdir(), 'fleet-image-'))
  try {
    // The image runs on the Docker server's architecture, which the staged packages must be installed for.
    const arch = await output(docker, ['version', '--format', '{{.Server.Arch}}'])
    await cp(join(PACKAGE_DIR, 'Dockerfile'), join(context, 'Dockerfile'))
    await stagePackage(PACKAGE_DIR, join(context, 'fleet'), NODE_ARCH[arch] ?? arch)
    // A provenance attestation records when it was built, which gives an unchanged build a new id.
    await run(docker, ['build', '--provenance=false', '--tag', tag, context])
  } finally {
    await rm(context, { recursive: true, force: true })
  }
}

/** @returns the command's trimmed stdout; a failure carries its stderr. */
async function output(command: string, args: string[]): Promise<string> {
  try {
    return (await promisify(execFile)(command, args)).stdout.trim()
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    throw new Error(`fleet: ${command} ${args[0]} failed: ${stderr || (error as Error).message}`, { cause: error })
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`fleet: ${command} ${args[0]} failed (${signal ?? `exit ${String(code)}`})`))
    })
  })
}
