/**
 * A session's spec: what the `fleet` command asked for its session beyond a
 * prompt, as fleet-tau stores it in `spec.json` beside a snapshot of the
 * agent directory. Plain data, shared by the host plugins and the worker that
 * reads agent directories.
 * @module fleet-tau/spec
 */

import { z } from 'zod'
import type { Skill } from './skills.ts'

/** Bumped when a stored spec changes shape; older ones are refused rather than misread. */
export const SPEC_VERSION = 1

/** Where a session's container sees its agent's snapshot. */
export const AGENT_VIEW = '/opt/fleet/agent'

export interface Spec {
  version: typeof SPEC_VERSION
  /** The agent directory the session was started from, and its name. */
  agent: { name: string; source: string }
  /** The command's arguments to the agent. */
  args: string[]
  /** PROMPT.md with the arguments filled in: the session's task. */
  prompt: string
  skills: Skill[]
}

const skillSchema = z.object({
  name: z.string(),
  description: z.string(),
  whenToUse: z.string().optional(),
  modelInvocable: z.boolean(),
  userInvocable: z.boolean(),
  dir: z.string(),
  content: z.string(),
})

export const specSchema: z.ZodType<Spec> = z.object({
  version: z.literal(SPEC_VERSION),
  agent: z.object({ name: z.string(), source: z.string() }),
  args: z.array(z.string()),
  prompt: z.string(),
  skills: z.array(skillSchema),
})
