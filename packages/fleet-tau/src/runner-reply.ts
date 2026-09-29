/**
 * The runner's reply, as the host reads it (./runner/protocol.ts). The runner
 * runs in the container, where the model is root and can replace it, so its
 * reply is parsed as the helper's messages are, never trusted as it is.
 * @module fleet-tau/runner-reply
 */

import { z } from 'zod'
import type { RunnerReply } from './runner/protocol.ts'

const failureSchema = z.object({
  name: z.string(),
  message: z.string(),
  diagnostics: z.array(z.object({
    category: z.string(), code: z.number(), message: z.string(), file: z.string().optional(), line: z.number().optional(), column: z.number().optional(),
  })).optional(),
  diagnosticsOmitted: z.number().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
})

const replySchema: z.ZodType<RunnerReply> = z.union([
  z.object({ ok: z.literal(true), modules: z.array(z.object({ specifier: z.string(), packageRoot: z.string(), description: z.string().optional() })) }),
  z.object({ ok: z.literal(true), value: z.unknown(), stdout: z.string(), stderr: z.string(), durationMs: z.number() }),
  z.object({ ok: z.literal(false), error: failureSchema }),
])

/** @returns the reply, or undefined for output that is not one. */
export function parseRunnerReply(text: string): RunnerReply | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const parsed = replySchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
