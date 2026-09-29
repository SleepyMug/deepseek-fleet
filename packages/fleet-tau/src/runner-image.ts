/**
 * The TypeScript runner's part of the session image, which `fleet-setup
 * image` compiles and installs at /opt/fleet/runner: image/runner holds its
 * manifest, lockfile and tsconfig, with ts-executor's tarball in vendor/
 * while that is not on npm, and src/runner its sources (./runner/main.ts).
 * The image carries the runner's protocol in a label, which the tools check
 * before they start it (./ts-tools.ts).
 * @module fleet-tau/runner-image
 */

import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNNER_PROTOCOL, RUNNER_PROTOCOL_LABEL } from './runner/protocol.ts'

/** This package's folder. */
const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url))
const BUILD_DIR = join(PACKAGE_DIR, 'image', 'runner')

/**
 * The runner as `fleet-setup image` builds it.
 * @throws when the runner depends on a ts-executor tarball that is not staged.
 */
export async function runnerPart(): Promise<{ build: string; sources: string; labels: Record<string, string> }> {
  await vendorStaged()
  return { build: BUILD_DIR, sources: join(PACKAGE_DIR, 'src', 'runner'), labels: { [RUNNER_PROTOCOL_LABEL]: String(RUNNER_PROTOCOL) } }
}

/**
 * Check that the runner's dependency on @sleepymug/ts-executor, when it is a
 * packed tarball, is there: scripts/stage-runner.mjs makes it from the linked
 * checkout while that version is not on npm.
 */
async function vendorStaged(): Promise<void> {
  const manifest = JSON.parse(await readFile(join(BUILD_DIR, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  const spec = manifest.dependencies?.['@sleepymug/ts-executor']
  if (spec === undefined || !spec.startsWith('file:')) return
  const vendor = join(BUILD_DIR, spec.slice('file:'.length))
  await access(vendor).catch(() => {
    throw new Error(`fleet-tau: ${vendor} is missing; stage it from the linked ts-executor checkout with \`node ${join(PACKAGE_DIR, 'scripts', 'stage-runner.mjs')}\``)
  })
}
