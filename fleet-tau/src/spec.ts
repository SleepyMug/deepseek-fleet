/**
 * A session's spec: what the `fleet` command asked for its session beyond a
 * prompt, as fleet-tau stores it in `spec.json` beside a snapshot of the
 * agent directory. Plain data, shared by the host plugins and the worker that
 * reads agent directories.
 * @module fleet-tau/spec
 */

import { z } from 'zod'

/** Bumped when a stored spec changes shape so that older ones would be misread; they are refused instead. */
export const SPEC_VERSION = 1

/** Where a session's container sees its agent's snapshot. */
export const AGENT_VIEW = '/opt/fleet/agent'

const skillSchema = z.object({
  name: z.string(),
  description: z.string(),
  whenToUse: z.string().optional(),
  modelInvocable: z.boolean(),
  userInvocable: z.boolean(),
  /** The skill's folder, relative to the agent's `skills/` folder, with `/` separators; `.` for `skills/` itself. */
  dir: z.string(),
  /** The instructions: SKILL.md after its frontmatter, trimmed. */
  content: z.string(),
})

export const specSchema = z.object({
  version: z.literal(SPEC_VERSION),
  /** The agent directory the session was started from, and its name. */
  agent: z.object({ name: z.string(), source: z.string() }),
  /** The command's arguments to the agent. */
  args: z.array(z.string()),
  /** PROMPT.md with the arguments filled in: the session's task. */
  prompt: z.string(),
  skills: z.array(skillSchema),
  /** The services the agent declares, each with its functions, which are all its programs may call. */
  services: z.record(z.string(), z.array(z.string())).default({}),
})

export type Spec = z.output<typeof specSchema>
export type Skill = z.output<typeof skillSchema>
