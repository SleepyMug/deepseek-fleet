/**
 * A session's spec: what the `fleet` command asked for its session beyond a
 * prompt, as fleet-tau stores it in `spec.json` beside a snapshot of the
 * agent directory. Plain data, shared by the host plugins and the worker that
 * reads agent directories.
 * @module fleet-runtime/tau/spec
 */

import { z } from 'zod'

/** Bumped when a stored spec changes shape so that older ones would be misread; they are refused instead. */
export const SPEC_VERSION = 3

/** Where a session's container sees its agent's snapshot. */
export const AGENT_VIEW = '/opt/fleet-tau/agent'

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

const apiSchema = z.object({
  /** The API's name: programs import it as `@api/<name>`, typed by the agent's `api/<name>.d.ts`, and fleet's implementation of the same name runs it. */
  name: z.string(),
  /** The agent's own description of it. */
  description: z.string().optional(),
  /** The fleet host's backends its implementation calls, which are all the session's programs may call. */
  backends: z.array(z.string()),
})

const pathSchema = z.object({
  /** The argument's name in tau.json. */
  name: z.string(),
  type: z.enum(['file', 'dir']),
  /** What the agent does with it, which decides how the container gets it (./store.ts). */
  role: z.enum(['in', 'out', 'inout']),
  /** The caller's path, absolute, which is where the container sees it too. */
  host: z.string(),
})

export const specSchema = z.object({
  version: z.literal(SPEC_VERSION),
  /** The agent directory the session was started from, and its name; none for a prompt run. */
  agent: z.object({ name: z.string(), source: z.string() }).optional(),
  /** The command's arguments to the agent. */
  args: z.array(z.string()),
  /** PROMPT.md with the arguments filled in, or the prompt as given: the session's task. */
  prompt: z.string(),
  skills: z.array(skillSchema),
  /** The APIs the agent declares, each linked to fleet's implementation. */
  apis: z.array(apiSchema),
  /** The caller's values of the variables tau.json lists, which every process in the container sees. */
  env: z.record(z.string(), z.string()),
  /** The path arguments, as tau binds them. */
  paths: z.array(pathSchema),
})

export type Spec = z.output<typeof specSchema>
export type Skill = z.output<typeof skillSchema>
export type SpecApi = z.output<typeof apiSchema>
export type SpecPath = z.output<typeof pathSchema>

/** The spec of a prompt run: no agent, nothing else. */
export function promptSpec(prompt: string): Spec {
  return { version: SPEC_VERSION, args: [], prompt, skills: [], apis: [], env: {}, paths: [] }
}
