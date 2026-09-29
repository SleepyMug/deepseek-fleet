/**
 * A session's spec: what the `fleet` command asked for its session beyond a
 * prompt, as fleet-tau stores it in `spec.json` beside a snapshot of the
 * agent directory. Plain data, shared by the host plugins and the worker that
 * reads agent directories.
 * @module fleet-tau/spec
 */

import { z } from 'zod'

/** Bumped when a stored spec changes shape so that older ones would be misread; they are refused instead. */
export const SPEC_VERSION = 3

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

const serviceSchema = z.object({
  description: z.string().optional(),
  /** The manifest's canonical declarations, as tau prints them: what programs import as `@svc/<name>`. */
  declarations: z.string(),
  /** The functions the agent declares, which are all its programs may call. */
  functions: z.array(z.string()),
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

const moduleSchema = z.object({
  /** The package name programs import it by. */
  name: z.string(),
  description: z.string().optional(),
  /** The module's folder under the agent's `modules/`. */
  dir: z.string(),
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
  /** The services the agent declares, by name. */
  services: z.record(z.string(), serviceSchema),
  modules: z.array(moduleSchema),
  /** The caller's values of the variables tau.json lists, which every process in the container sees. */
  env: z.record(z.string(), z.string()),
  /** The path arguments, as tau binds them. */
  paths: z.array(pathSchema),
})

export type Spec = z.output<typeof specSchema>
export type Skill = z.output<typeof skillSchema>
export type SpecService = z.output<typeof serviceSchema>
export type SpecModule = z.output<typeof moduleSchema>
export type SpecPath = z.output<typeof pathSchema>

/** The spec of a prompt run: no agent, nothing else. */
export function promptSpec(prompt: string): Spec {
  return { version: SPEC_VERSION, args: [], prompt, skills: [], services: {}, modules: [], env: {}, paths: [] }
}
