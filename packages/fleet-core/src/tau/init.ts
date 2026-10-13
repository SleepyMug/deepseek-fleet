/**
 * A tau's init (tau's docs/spec/init.md): the command a run's box runs in
 * the agent's working directory before the agent (./runs.ts), whose exit says
 * what comes next: the agent skipped, init's stdout the run's final text;
 * the agent run on the prompt as it is; or, for any other ending, the agent
 * run on the prompt and told, after it, that init failed, with what it
 * wrote (./service.ts).
 * @module @sleepymug/fleet-core/tau/init
 */

import { initDecision } from '@sleepymug/tau/backend'
import type { InitEnd } from './runs.ts'

/** What an init's end has the run do, as tau's backend SDK says: an end without a code falls back. */
export function nextOf({ code }: InitEnd): 'skip' | 'run' | 'fallback' {
  return initDecision(code ?? undefined)
}

/** The prompt of a run whose init failed: the tau's own, then that init failed, and what it wrote. */
export function fellBack(prompt: string, command: string, end: InitEnd): string {
  const how = end.code === null ? `was killed by ${String(end.signal)}` : `exited with ${end.code}`
  return [
    prompt.trimEnd(),
    '',
    '---',
    '',
    `This TAU's init, ${code(command, 1)}, ran before you, and failed: it ${how}. Do the task yourself; `
      + 'what init left at the files is still there.',
    '',
    `Its stdout:${written(end.stdout)}`,
    '',
    `Its stderr:${written(end.stderr)}`,
  ].join('\n') + '\n'
}

/** What a stream got: nothing, or the text in a fenced block. */
function written(text: string): string {
  return text === '' ? ' nothing.' : `\n\n${code(text.endsWith('\n') ? text : `${text}\n`, 3)}`
}

/** Text as code, inline or, from three backticks, fenced, in more backticks than any run of them in it. */
function code(text: string, least: number): string {
  const fence = '`'.repeat(Math.max(least, ...[...text.matchAll(/`+/gu)].map(([run]) => run.length + 1)))
  if (least >= 3) return `${fence}\n${text}${fence}`
  return fence.length > 1 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`
}
