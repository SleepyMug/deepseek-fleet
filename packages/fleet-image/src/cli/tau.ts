/**
 * `tau`, the command on a session container's PATH: `tau run <agent-dir>
 * [args...]` runs an agent directory in the tau format as fleet's `tau` API
 * does (../apis/tau/), and so works only in a session whose agent declares
 * that API. As tau's SPEC.md has a command do, it writes the agent's final
 * message to stdout and why the run failed to stderr, and exits with 0 only
 * when the run succeeded. Ctrl-C, or any signal that ends it, cancels the run.
 * @module fleet-image/cli/tau
 */

import { run } from '../apis/tau/index.ts'

const USAGE = 'Usage: tau run <agent-dir> [args...]   run an agent directory (tau format) as a run of its own, and wait for it'

const [command, agent, ...args] = process.argv.slice(2)
if (command === '--help' || command === '-h') {
  process.stdout.write(`${USAGE}\n`)
} else if (command !== 'run' || agent === undefined) {
  process.stderr.write(`${USAGE}\n`)
  process.exitCode = 2
} else {
  const cancelled = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => { cancelled.abort(new Error(`tau got ${signal}`)) })
  try {
    const result = await run(agent, args, cancelled.signal)
    if (result.message !== '') process.stdout.write(`${result.message}\n`)
    if (!result.ok) process.stderr.write(`tau: ${result.failure ?? 'the run failed'}\n`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`tau: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = cancelled.signal.aborted ? 130 : 1
  }
}
