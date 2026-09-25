/**
 * The session image every container runs, and what the world relies on
 * inside it. It is a prerequisite of fleet-world, built by `build-image` from
 * this package's `image/` folder; startup only looks it up.
 * @module fleet-world/image
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The image definition this package ships. */
export const IMAGE_DIR = fileURLToPath(new URL('../image/', import.meta.url))
/**
 * The files the image is built from, relative to `IMAGE_DIR`. They are the
 * whole build context and all its tag digests, so a Dockerfile that uses any
 * other file fails to build instead of leaving the tag stale. The helper's
 * lockfile is an npm-shrinkwrap.json because packing drops package-lock.json.
 */
export const IMAGE_INPUTS: readonly string[] = ['Dockerfile', 'helper/npm-shrinkwrap.json', 'helper/package.json']
/** Where the Dockerfile installs Node and the dsh-ssh helper. */
export const HELPER_NODE = '/usr/local/bin/node'
export const HELPER_ENTRY = '/opt/fleet-world/helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js'

/** @returns the image's tag, a digest of its inputs. */
export async function imageTag(): Promise<string> {
  const digest = createHash('sha256')
  for (const file of IMAGE_INPUTS) digest.update(`${file}\0`).update(await readFile(join(IMAGE_DIR, file))).update('\0')
  return `fleet-world:${digest.digest('hex').slice(0, 12)}`
}

/** @returns the SHA-256 of the host's dsh-ssh helper; the image's copy must match it. */
export async function helperHash(): Promise<string> {
  const helper = await readFile(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-ssh/helper')))
  return createHash('sha256').update(helper).digest('hex')
}
