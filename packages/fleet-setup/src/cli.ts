#!/usr/bin/env node
/**
 * `fleet-setup`: what the fleet profile needs on this machine outside dsh.
 * `image` builds the session image fleet-box uses, with the runtime of this
 * checkout's packages on an environment (./image.ts). In the fleet
 * checkout, `pnpm image` builds the workspace, then runs `fleet-setup
 * image`. Signing in to a model provider happens in dsh, in a profile of its
 * own (fleet-signin's app).
 * @module fleet-setup/cli
 */

import { execFile } from 'node:child_process'
import { parseArgs } from 'node:util'
import { DEFAULT_IMAGE } from 'fleet-image/helper/image'
import { buildImage } from './image.ts'

const DOCKER = 'docker'

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_USAGE = 2

const USAGE = [
  'Usage: fleet-setup <part>',
  '  image [--from <image>] [--tag <tag>]',
  '                     build the session image: fleet\'s runtime on its own environment, or on the --from image;',
  `                     tagged ${DEFAULT_IMAGE}, which fleet-box uses, or --tag, which its \`image\` setting must name`,
].join('\n')

async function main(args: readonly string[]): Promise<number> {
  const [part, ...rest] = args
  if (part === 'image') {
    const options = imageOptions(rest)
    if (options === undefined) {
      say(USAGE)
      return EXIT_USAGE
    }
    await dockerResponds()
    await buildImage({ docker: DOCKER, tag: options.tag ?? DEFAULT_IMAGE, ...options.from === undefined ? {} : { from: options.from }, log: say })
    return EXIT_OK
  }
  const help = args.length === 1 && (part === '--help' || part === '-h')
  if (!help && args.length > 0) say(`Unexpected arguments: ${args.join(' ')}`)
  say(USAGE)
  return help ? EXIT_OK : EXIT_USAGE
}

/** @returns `image`'s options, or undefined, having said why, when they are not options it takes. */
function imageOptions(args: string[]): { from?: string; tag?: string } | undefined {
  try {
    return parseArgs({ args, options: { from: { type: 'string' }, tag: { type: 'string' } }, strict: true }).values
  } catch (error) {
    say(error instanceof Error ? error.message : String(error))
    return undefined
  }
}

/** Fail early and plainly when the Docker daemon is not reachable, rather than on a build step. */
function dockerResponds(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(DOCKER, ['version', '--format', '{{.Server.Version}}'], (error, _stdout, stderr) => {
      if (error === null) resolve()
      else reject(new Error(`fleet-setup: Docker does not respond; start it and run \`fleet-setup image\` again: ${stderr.trim() || error.message}`))
    })
  })
}

function say(line: string): void {
  process.stderr.write(`${line}\n`)
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  say(error instanceof Error ? error.message : String(error))
  process.exitCode = EXIT_FAILED
}
