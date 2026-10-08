/**
 * One-shot terminal sign-in app for `ctx.authorization` flows, booted as a
 * dsh profile of its own, dsh-base with this package's bundle
 * (`dsh fleet-signin [provider]`): after startup it runs one attempt, prints
 * the flow's notices to stderr, answers its prompts from stdin, and requests
 * exit. The flow owns the credential write; a running dsh sharing the same
 * Harness home picks the record up without a restart.
 * @module @sleepymug/fleet-signin/app
 */

import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationEntry, AuthorizationInteraction } from '@deepseek-ai/dsh-authorization'
import { credentialKey, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-cmdline'

export const name = 'fleet-signin'
export const inject = ['authorization']

export interface Config {
  /** Provider signed in to when none is named: the ChatGPT subscription route. */
  provider: string
  /** Credential scope for a bare provider argument, so `openai-codex` means `llm-pi-ai/openai-codex`. */
  defaultScope: string
}

export const Config: Schema<Config> = Schema.object({
  provider: Schema.string().default('openai-codex').description('Provider signed in to when none is named.'),
  defaultScope: Schema.string().default('llm-pi-ai').description('Credential scope for a bare provider argument.'),
})

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_USAGE = 2

export function apply(ctx: Context, config: Config): void {
  const cmdline = ctx.get('cmdlineArgs')
  const exit = ctx.get('appExit')
  const ready = ctx.get('appReady')
  if (cmdline === undefined || exit === undefined || ready === undefined) {
    throw new Error('fleet-signin: boot it as a profile of its own, `dsh fleet-signin`; the launcher must provide ctx.cmdlineArgs, ctx.appExit and ctx.appReady')
  }
  const args = cmdline.get()
  ctx.effect(() => {
    const controller = new AbortController()
    // Flows register while the tree starts, so the attempt waits for startup to commit.
    const cancelReady = ready.onReady(() => {
      run(ctx, config, args, controller.signal).then(exit, (error: unknown) => {
        // Disposal aborts the attempt; the launcher is already exiting then.
        if (controller.signal.aborted) return
        say(`Sign-in failed; nothing was stored: ${error instanceof Error ? error.message : String(error)}`)
        exit(EXIT_FAILED)
      })
    })
    return () => {
      cancelReady()
      controller.abort()
    }
  }, 'fleet-signin attempt')
}

/**
 * @param args - the arguments after `dsh fleet-signin`.
 * @param signal - aborted when the app shuts down.
 * @returns the process exit code.
 */
async function run(ctx: Context, config: Config, args: readonly string[], signal: AbortSignal): Promise<number> {
  const [target = config.provider, ...extra] = args
  if (target === '--help' || target === '-h') {
    usage(ctx, config)
    return EXIT_OK
  }
  if (extra.length > 0) {
    say(`Expected one provider, got: ${args.join(' ')}`)
    usage(ctx, config)
    return EXIT_USAGE
  }
  const key: CredentialKey = target.includes('/') ? parseCredentialKey(target) : credentialKey(config.defaultScope, target)
  const entry = ctx.authorization.describe(key)
  if (entry === undefined) {
    say(`No sign-in is available for ${key}.`)
    usage(ctx, config)
    return EXIT_FAILED
  }
  const interaction = terminalInteraction()
  const method = entry.methods.length === 1 ? entry.methods[0].id : await interaction.prompt({
    kind: 'select',
    message: `Sign in to ${entry.label} with:`,
    options: entry.methods.map(option => ({ id: option.id, label: option.label })),
  })
  say(`Signing in to ${entry.label} (${key}). Ctrl-D at a prompt declines; Ctrl-C aborts.`)
  const outcome = await ctx.authorization.begin({ key, method, interaction, signal })
  if (outcome.status === 'authorized') {
    say(`Signed in; the credential is stored as ${key}. A running dsh picks it up without a restart.`)
    return EXIT_OK
  }
  say('Sign-in cancelled; nothing was stored.')
  return EXIT_FAILED
}

function usage(ctx: Context, config: Config): void {
  const entries = [...ctx.authorization.list()].sort((left, right) => left.key.localeCompare(right.key))
  const scopePrefix = `${config.defaultScope}/`
  const argument = (entry: AuthorizationEntry): string => entry.key.startsWith(scopePrefix) ? entry.key.slice(scopePrefix.length) : entry.key
  const width = Math.max(0, ...entries.map(entry => argument(entry).length))
  say([
    `Usage: dsh fleet-signin [provider]   (default ${config.provider}; a bare provider means ${scopePrefix}<provider>; <scope>/<id> names any flow)`,
    entries.length === 0 ? 'No sign-in flows are registered.' : 'Available sign-ins:',
    ...entries.map(entry => `  ${argument(entry).padEnd(width)}  ${entry.label}`),
  ].join('\n'))
}

function terminalInteraction(): AuthorizationInteraction {
  return {
    notify(notice) {
      const callback = notice.url === undefined ? undefined : loopbackRedirect(notice.url)
      say([
        notice.message,
        ...notice.url === undefined ? [] : [`  Open: ${notice.url}`],
        ...notice.code === undefined ? [] : [`  Code: ${notice.code}`],
        ...callback === undefined ? [] : [
          `  The page redirects to ${callback.origin} on the machine running the browser.`,
          '  If that is not this machine, the final page will not load: copy its full URL',
          '  from the address bar and paste it at the prompt, or forward the port first:',
          `  ssh -L ${callback.port}:127.0.0.1:${callback.port} <this host>`,
        ],
      ].join('\n'))
    },
    async prompt(prompt) {
      if (prompt.kind === 'select') {
        const lines = prompt.options.map((option, index) => `  ${index + 1}) ${option.label}`)
        say([prompt.message, ...lines].join('\n'))
        for (;;) {
          const answer = await ask('Choice [1]: ', prompt.signal)
          if (answer === '') return prompt.options[0]?.id ?? ''
          const chosen = prompt.options[Number(answer) - 1] ?? prompt.options.find(option => option.id === answer)
          if (chosen !== undefined) return chosen.id
          say(`Enter a number from 1 to ${prompt.options.length}.`)
        }
      }
      // Line input goes through the terminal's own echo, so a secret is visible while typed.
      const hint = prompt.kind === 'secret' ? ' (input is visible)' : ''
      say(prompt.placeholder === undefined ? `${prompt.message}${hint}` : `${prompt.message}${hint}\n  e.g. ${prompt.placeholder}`)
      for (;;) {
        const answer = await ask('> ', prompt.signal)
        if (answer !== '') return answer
      }
    },
  }
}

/**
 * Read one line from stdin.
 * @param query - printed before reading.
 * @param signal - withdraws the question without declining.
 * @returns the trimmed line.
 */
function ask(query: string, signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    // `terminal: false` leaves Ctrl-C to the process, so it still stops dsh.
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false })
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', withdraw)
      rl.close()
      settle()
    }
    // A flow withdraws a question it no longer needs, such as a pasted code
    // after the browser callback won; that is not the human declining.
    const withdraw = (): void => { finish(() => { reject(new Error('prompt withdrawn by the sign-in flow')) }) }
    rl.once('close', () => { finish(() => { reject(new AuthorizationDeclinedError('stdin closed before the prompt was answered')) }) })
    if (signal?.aborted) {
      withdraw()
      return
    }
    signal?.addEventListener('abort', withdraw, { once: true })
    process.stderr.write(query)
    rl.once('line', (line) => { finish(() => { resolve(line.trim()) }) })
  })
}

/**
 * The OAuth loopback callback a sign-in page redirects to, if any.
 * @param pageUrl - the page the human is asked to open.
 * @returns the `redirect_uri` when it targets this host's loopback, else undefined.
 */
function loopbackRedirect(pageUrl: string): URL | undefined {
  let redirect: URL | undefined
  try {
    const raw = new URL(pageUrl).searchParams.get('redirect_uri')
    redirect = raw === null ? undefined : new URL(raw)
  } catch (_notAUrl) {
    // Notices may carry any page; one that is not a URL has no redirect to explain.
    return undefined
  }
  return redirect !== undefined && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) ? redirect : undefined
}

function say(text: string): void {
  process.stderr.write(`[signin] ${text}\n`)
}
