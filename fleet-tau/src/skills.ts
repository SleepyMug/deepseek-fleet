/**
 * An agent's skills, as tau defines them: every folder under the agent's
 * `skills/` that holds a `SKILL.md`, at any depth; a skill's own folder is not
 * searched further. Each `SKILL.md` is read as dsh's file-system provider
 * reads one, whose parser is private to it: YAML frontmatter between `---`
 * lines with a kebab-case `name` and a `description`, an optional
 * `whenToUse`, and the invocation flags `disable-model-invocation` and
 * `user-invocable`; the body is the skill's content. Unlike that provider,
 * which skips a broken skill with a warning, this reports it, so a run is
 * refused before its agent misses a skill.
 * @module fleet-tau/skills
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** Kebab-case, as `isSkillName` in @deepseek-ai/dsh-skill requires. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** One skill of an agent. */
export interface Skill {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  /** The skill's folder, relative to the agent's `skills/` folder, with `/` separators; `.` for `skills/` itself. */
  dir: string
  /** The instructions: SKILL.md after its frontmatter, trimmed. */
  content: string
}

/**
 * Find and read an agent's skills.
 * @param agentDir - the agent directory, whose `skills/` may be missing.
 * @returns the skills, and a problem for each skill that cannot be read or shares its name with another.
 */
export function loadSkills(agentDir: string): { skills: Skill[]; problems: string[] } {
  const root = join(agentDir, 'skills')
  const skills: Skill[] = []
  const problems: string[] = []
  if (!existsSync(root)) return { skills, problems }
  if (!statSync(root).isDirectory()) return { skills, problems: [`${root}: skills must be a folder`] }
  for (const dir of skillFolders(root)) {
    const file = join(dir, 'SKILL.md')
    try {
      skills.push({ ...parseSkill(readFileSync(file, 'utf8')), dir: relative(root, dir).split(sep).join('/') || '.' })
    } catch (error) {
      problems.push(`${file}: ${message(error)}`)
    }
  }
  const seen = new Map<string, string>()
  for (const skill of skills) {
    const other = seen.get(skill.name)
    if (other !== undefined) problems.push(`${root}: the skills in ${other} and ${skill.dir} are both named ${skill.name}`)
    seen.set(skill.name, skill.dir)
  }
  return { skills, problems }
}

/** The folders holding a SKILL.md, in a stable order; hidden folders and node_modules are skipped. */
function skillFolders(dir: string): string[] {
  if (existsSync(join(dir, 'SKILL.md'))) return [dir]
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .filter(entry => entry.isDirectory() || (entry.isSymbolicLink() && statSync(join(dir, entry.name)).isDirectory()))
    .map(entry => entry.name)
    .sort()
    .flatMap(name => skillFolders(join(dir, name)))
}

/**
 * Read one SKILL.md.
 * @throws naming what is wrong with it.
 */
export function parseSkill(raw: string): Omit<Skill, 'dir'> {
  const parsed = parseFrontmatter(raw)
  if (parsed === undefined) throw new Error('SKILL.md needs YAML frontmatter between --- lines')
  const { data, body } = parsed
  const name = stringField(data, 'name')
  const description = stringField(data, 'description')
  if (name === undefined || description === undefined) throw new Error('the frontmatter needs a name and a description')
  if (!SKILL_NAME.test(name)) throw new Error(`the skill name "${name}" is not kebab-case`)
  rejectLegacyKey(data, 'disableModelInvocation', 'disable-model-invocation')
  rejectLegacyKey(data, 'modelInvocable', 'disable-model-invocation')
  rejectLegacyKey(data, 'userInvocable', 'user-invocable')
  const whenToUse = stringField(data, 'whenToUse')
  return {
    name,
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    modelInvocable: frontmatterBoolean(data, 'disable-model-invocation') !== true,
    userInvocable: frontmatterBoolean(data, 'user-invocable') !== false,
    content: body.trim(),
  }
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const lines = raw.replace(/^\uFEFF/u, '').split('\n')
  if (lines[0]?.replace(/\r$/u, '') !== '---') return undefined
  const closing = lines.findIndex((line, index) => index > 0 && line.replace(/\r$/u, '') === '---')
  if (closing === -1) return undefined
  let data: unknown
  try {
    data = parseYaml(lines.slice(1, closing).join('\n'))
  } catch (error) {
    throw new Error(`the frontmatter is not valid YAML: ${message(error)}`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('the frontmatter must be a YAML mapping')
  return { data: data as Record<string, unknown>, body: lines.slice(closing + 1).join('\n') }
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function rejectLegacyKey(data: Record<string, unknown>, legacy: string, canonical: string): void {
  if (Object.hasOwn(data, legacy)) throw new Error(`the frontmatter field "${legacy}" is not supported; use "${canonical}"`)
}

/** A frontmatter flag, read as dsh reads one: YAML booleans, 1/0, and true/yes/on or false/no/off in any case. */
function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    if (lower === 'true' || lower === 'yes' || lower === 'on') return true
    if (lower === 'false' || lower === 'no' || lower === 'off') return false
  }
  throw new Error(`the frontmatter field "${key}" must be a boolean`)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
