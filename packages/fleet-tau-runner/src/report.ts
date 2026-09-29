/**
 * What the model sees of a program's run, bounded (adapted from pi-run's
 * execute-report.ts): the head and tail of each output stream, the return
 * value unless it is large, and a failure's message and first diagnostics.
 * The whole reply is bounded in bytes too, {@link MAX_REPLY_BYTES}, since the
 * host keeps only the tail of the runner's stdout and a reply cut there
 * could not be read: a reply over it is shrunk until it fits.
 * @module fleet-tau-runner/report
 */

import { MAX_REPLY_BYTES, type RunnerFailure, type RunnerReply } from './protocol.ts'

/** Characters of stdout and of stderr a run reports: the head and the tail. */
export const OUTPUT_CHARS = 32 * 1024
/** Largest serialized return value reported; a larger one is replaced by a notice and a preview. */
const VALUE_CHARS = 64 * 1024
const PREVIEW_CHARS = 1024
/** Characters of an error message reported. */
const MESSAGE_CHARS = 32 * 1024
/** Type diagnostics reported, in source order, and characters of each one's message. */
const DIAGNOSTICS = 20
const DIAGNOSTIC_CHARS = 2 * 1024

/** Whether cutting `text` at `index` would separate the two UTF-16 halves of one character. */
function splitsPair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false
  const code = text.charCodeAt(index - 1)
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * The first and last `cap / 2` UTF-16 units of a stream and a count of the
 * rest, cut between characters, in memory a small multiple of `cap` however
 * much the program writes. ts-executor decodes each chunk whole, so a
 * character never spans two pushes.
 */
export class OutputCapture {
  readonly #half: number
  #head = ''
  #headFull = false
  #tail = ''
  #dropped = 0

  constructor(cap: number) {
    this.#half = Math.max(1, Math.floor(cap / 2))
  }

  readonly push = (text: string): void => {
    if (!this.#headFull) {
      const room = this.#half - this.#head.length
      const cut = Math.min(text.length, splitsPair(text, room) ? room - 1 : room)
      this.#head += text.slice(0, cut)
      if (cut === text.length && this.#head.length < this.#half) return
      this.#headFull = true
      text = text.slice(cut)
    }
    this.#tail += text
    // Trimmed only once twice its size, so trimming costs O(1) per character.
    if (this.#tail.length > 2 * this.#half) this.#trim()
  }

  text(): string {
    if (this.#tail.length > this.#half) this.#trim()
    return this.#head + (this.#dropped === 0 ? '' : `\n[truncated ${this.#dropped} characters]\n`) + this.#tail
  }

  #trim(): void {
    let start = this.#tail.length - this.#half
    if (splitsPair(this.#tail, start)) start += 1
    this.#dropped += start
    this.#tail = this.#tail.slice(start)
  }
}

/** The stdout and stderr captures of one run. */
export function outputCaptures(): { stdout: OutputCapture; stderr: OutputCapture } {
  return { stdout: new OutputCapture(OUTPUT_CHARS), stderr: new OutputCapture(OUTPUT_CHARS) }
}

type Captures = ReturnType<typeof outputCaptures>

export function capText(text: string, cap: number): string {
  if (text.length <= cap) return text
  const cut = splitsPair(text, cap) ? cap - 1 : cap
  return `${text.slice(0, cut)}\n[truncated ${text.length - cut} characters]`
}

export function reportResult(value: unknown, durationMs: number, output: Captures): Extract<RunnerReply, { value: unknown }> {
  // ts-executor returns JSON only, so this always serializes.
  const serialized = JSON.stringify(value)
  return {
    ok: true,
    value: serialized.length > VALUE_CHARS ? tooLarge(serialized) : value,
    stdout: output.stdout.text(),
    stderr: output.stderr.text(),
    durationMs: Math.round(durationMs),
  }
}

/** A return value too large to report, as a notice and the start of it. */
function tooLarge(serialized: string): { truncated: true; notice: string; preview: string } {
  return {
    truncated: true,
    notice: `The return value is ${serialized.length} characters, over the ${VALUE_CHARS}-character limit; write large results to a file and return its path.`,
    preview: capText(serialized, PREVIEW_CHARS),
  }
}

/**
 * Anything a run throws, as a bounded failure.
 * @param timedOut - whether the runner's deadline, rather than a caller, ended the run.
 */
export function reportFailure(error: unknown, output: Captures | undefined, timeoutMs: number, timedOut: boolean): RunnerFailure {
  const streams = output === undefined ? {} : { stdout: output.stdout.text(), stderr: output.stderr.text() }
  if (timedOut) {
    return {
      name: 'TimeoutError',
      message: `The program ran longer than ${timeoutMs / 1000} s and was killed, with the processes in its process group.`,
      ...streams,
    }
  }
  if (!(error instanceof Error)) return { name: 'Error', message: capText(String(error), MESSAGE_CHARS), ...streams }
  const diagnostics = (error as { diagnostics?: RunnerFailure['diagnostics'] }).diagnostics
  const omitted = Math.max(0, (diagnostics?.length ?? 0) - DIAGNOSTICS)
  return {
    name: error.name,
    message: capText(error.message, MESSAGE_CHARS),
    ...diagnostics === undefined
      ? {}
      : { diagnostics: diagnostics.slice(0, DIAGNOSTICS).map(diagnostic => ({ ...diagnostic, message: capText(diagnostic.message, DIAGNOSTIC_CHARS) })) },
    ...omitted > 0 ? { diagnosticsOmitted: omitted } : {},
    ...streams,
  }
}

/**
 * The reply as one line within {@link MAX_REPLY_BYTES}: as it is, or with its
 * output, value and diagnostics cut further until it fits.
 */
export function replyLine(reply: RunnerReply, limit = MAX_REPLY_BYTES): string {
  let line = JSON.stringify(reply)
  for (const chars of [4096, 256]) {
    if (Buffer.byteLength(line) <= limit) return line
    line = JSON.stringify(shrink(reply, chars))
  }
  if (Buffer.byteLength(line) <= limit) return line
  return JSON.stringify({ ok: false, error: { name: 'ReplyTooLargeError', message: `the runner's reply would be over ${limit} bytes` } } satisfies RunnerReply)
}

function shrink(reply: RunnerReply, chars: number): RunnerReply {
  const cut = (text: string | undefined): string | undefined => text === undefined ? undefined : capText(text, chars)
  if (!reply.ok) {
    const { error } = reply
    return {
      ok: false,
      error: {
        name: error.name,
        message: cut(error.message) ?? '',
        ...error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics.slice(0, 5).map(diagnostic => ({ ...diagnostic, message: capText(diagnostic.message, chars) })) },
        ...error.stdout === undefined ? {} : { stdout: cut(error.stdout) },
        ...error.stderr === undefined ? {} : { stderr: cut(error.stderr) },
      },
    }
  }
  if ('value' in reply) {
    const serialized = JSON.stringify(reply.value)
    return { ...reply, value: serialized.length > chars ? tooLarge(serialized) : reply.value, stdout: capText(reply.stdout, chars), stderr: capText(reply.stderr, chars) }
  }
  return { ...reply, modules: reply.modules.slice(0, chars / 16).map(module => ({ ...module, description: cut(module.description) })) }
}
