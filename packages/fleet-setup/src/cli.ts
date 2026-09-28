/**
 * `fleet-setup`: what the fleet profile needs on this machine besides its
 * installed packages. `image` builds the session image this installation's
 * fleet-box needs. `signin` signs in to a model provider through dsh's own
 * sign-in flows, by booting dsh in a minimal profile of its own
 * (`fleet-signin`) with the sign-in app overlaid. Run it from the profile it
 * is installed in, `dsh plugin --profile fleet exec fleet-setup <part>`, or as
 * `node <fleet-setup>/bin.js <part>` with dsh on PATH.
 * @module fleet-setup/cli
 */

import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareImage } from 'fleet-box/image'

const DOCKER = 'docker'
/** dsh from PATH; `dsh plugin … exec` runs this command with the invoking shell's PATH. */
const DSH = 'dsh'
/** The minimal profile the sign-in app boots in: dsh-base with this package installed. */
const SIGNIN_PROFILE = 'fleet-signin'
const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url))
const SIGNIN_PATCH = fileURLToPath(new URL('../signin.patch.yml', import.meta.url))

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_USAGE = 2

const USAGE = [
  'Usage: fleet-setup <part>',
  '  image              build the session image fleet-box needs, then remove older unused ones',
  '  signin [provider]  sign in to a model provider; the default is openai-codex, a ChatGPT subscription;',
  '                     `signin --help` lists the providers',
].join('\n')

async function main(args: readonly string[]): Promise<number> {
  const [part, ...rest] = args
  if (part === 'image' && rest.length === 0) {
    await dockerResponds()
    await prepareImage({ docker: DOCKER, log: say })
    return EXIT_OK
  }
  if (part === 'signin') return signin(rest)
  const help = args.length === 1 && (part === '--help' || part === '-h')
  if (!help && args.length > 0) say(`Unexpected arguments: ${args.join(' ')}`)
  say(USAGE)
  return help ? EXIT_OK : EXIT_USAGE
}

/**
 * Point the sign-in profile at this copy of fleet-setup, then run the app in it.
 * @param args - passed to the app: a provider, or `--help`.
 * @returns the app's exit code.
 */
async function signin(args: readonly string[]): Promise<number> {
  // Idempotent, and it keeps the profile on the same copy as this command.
  const added = await run(['plugin', '--profile', SIGNIN_PROFILE, 'add', PACKAGE_DIR], 'pipe')
  if (added.code !== 0) throw new Error(`fleet-setup: could not prepare the ${SIGNIN_PROFILE} profile:\n${added.output.trim()}`)
  // Ctrl-C reaches dsh as well, which owns the attempt; wait for its answer instead of dying first.
  const ignore = (): void => {}
  process.on('SIGINT', ignore)
  try {
    return (await run(['--profile', SIGNIN_PROFILE, '--patch', SIGNIN_PATCH, ...args], 'inherit')).code
  } finally {
    process.off('SIGINT', ignore)
  }
}

/** Run dsh; `pipe` collects its output, `inherit` gives it the terminal. */
function run(args: readonly string[], stdio: 'pipe' | 'inherit'): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(DSH, args, { stdio: stdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT'
        ? new Error('fleet-setup: dsh is not on PATH; run this through dsh (`dsh plugin --profile <profile> exec fleet-setup …`) or put dsh on PATH')
        : error)
    })
    child.once('close', (code) => { resolve({ code: code ?? EXIT_FAILED, output }) })
  })
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
