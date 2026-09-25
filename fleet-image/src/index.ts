/**
 * One-shot app that builds fleet-world's session image. Mount it as its own
 * profile and run `dsh fleet-image`: after startup it builds the image its
 * fleet-world needs unless that exists, checks the image, removes older
 * fleet-world images no container uses, and requests exit. The fleet profile
 * only looks the image up, so building it stays a setup step apart from
 * installing the software.
 * @module fleet-image
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cmdline'
import { prepareImage } from 'fleet-world/image'

export const name = 'fleet-image'

export interface Config {
  /** Docker CLI executable. */
  docker: string
}

export const Config: Schema<Config> = Schema.object({
  docker: Schema.string().default('docker').description('Docker CLI executable.'),
})

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_USAGE = 2

export function apply(ctx: Context, config: Config): void {
  const cmdline = ctx.get('cmdlineArgs')
  const exit = ctx.get('appExit')
  const ready = ctx.get('appReady')
  if (cmdline === undefined || exit === undefined || ready === undefined) {
    throw new Error('fleet-image: run it as its own profile (`dsh fleet-image`); the launcher must provide ctx.cmdlineArgs, ctx.appExit and ctx.appReady')
  }
  const args = cmdline.get()
  ctx.effect(() => {
    const controller = new AbortController()
    const cancelReady = ready.onReady(() => {
      run(config, args, controller.signal).then(exit, (error: unknown) => {
        // Disposal aborts the build; the launcher is already exiting then.
        if (controller.signal.aborted) return
        say(error instanceof Error ? error.message : String(error))
        exit(EXIT_FAILED)
      })
    })
    return () => {
      cancelReady()
      controller.abort()
    }
  }, 'fleet-image build')
}

/**
 * @param args - the app arguments after `dsh fleet-image`.
 * @param signal - aborted when the app shuts down.
 * @returns the process exit code.
 */
async function run(config: Config, args: readonly string[], signal: AbortSignal): Promise<number> {
  if (args.length > 0) {
    const help = args.length === 1 && (args[0] === '--help' || args[0] === '-h')
    if (!help) say(`Unexpected arguments: ${args.join(' ')}`)
    say('Usage: dsh fleet-image   (build the session image fleet-world needs, then remove older unused ones)')
    return help ? EXIT_OK : EXIT_USAGE
  }
  await prepareImage({ docker: config.docker, log: say, signal })
  return EXIT_OK
}

function say(line: string): void {
  process.stderr.write(`${line}\n`)
}
