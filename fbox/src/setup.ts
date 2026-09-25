/**
 * `fleet-setup`: prepare this machine for fbox. It checks that Docker
 * responds, builds the session image this copy of fbox needs unless it
 * exists, checks the image, and removes older fbox images no container uses.
 * Run it after installing or updating fbox, as `node <fbox>/bin.js`; fbox
 * itself only looks the image up when dsh starts.
 * @module fbox/setup
 */

import { execFile } from 'node:child_process'
import { prepareImage } from './image.ts'

const DOCKER = 'docker'
const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_USAGE = 2

async function main(args: readonly string[]): Promise<number> {
  if (args.length > 0) {
    const help = args.length === 1 && (args[0] === '--help' || args[0] === '-h')
    if (!help) say(`Unexpected arguments: ${args.join(' ')}`)
    say('Usage: fleet-setup   (build the session image fbox needs, then remove older unused ones; run it after installing or updating fbox)')
    return help ? EXIT_OK : EXIT_USAGE
  }
  await dockerResponds()
  await prepareImage({ docker: DOCKER, log: say })
  return EXIT_OK
}

/** Fail early and plainly when the Docker daemon is not reachable, rather than on a build step. */
function dockerResponds(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(DOCKER, ['version', '--format', '{{.Server.Version}}'], (error, _stdout, stderr) => {
      if (error === null) resolve()
      else reject(new Error(`fbox: Docker does not respond; start it and run fleet-setup again: ${stderr.trim() || error.message}`))
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
