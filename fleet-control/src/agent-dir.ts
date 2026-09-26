/**
 * Agent directories, as pi-run defines them: `PROMPT.md` is a pi prompt
 * template, filled with the command's arguments, and `skills/` holds the
 * agent's skills. dsh has no prompt templates, so the template is filled
 * here, by pi's own rules: `$1`, `$@` or `$ARGUMENTS`, `${N:-default}`,
 * `${@:-default}`, `${@:N}` and `${@:N:L}`, with leading YAML frontmatter
 * dropped as pi drops it.
 * @module fleet-control/agent-dir
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** An agent: a directory with PROMPT.md and, optionally, skills/. */
export interface Agent {
  dir: string
  /** The directory's name, which titles its sessions. */
  name: string
  /** PROMPT.md without its frontmatter. */
  template: string
  skillsDir: string | undefined
}

/**
 * @param dir - absolute path of the agent directory.
 * @throws when it has no PROMPT.md.
 */
export function loadAgent(dir: string): Agent {
  const promptPath = join(dir, 'PROMPT.md')
  if (!existsSync(promptPath)) throw new Error(`not an agent directory (no PROMPT.md): ${dir}`)
  const skillsDir = join(dir, 'skills')
  return {
    dir,
    name: basename(dir),
    template: stripFrontmatter(readFileSync(promptPath, 'utf8')),
    skillsDir: existsSync(skillsDir) ? skillsDir : undefined,
  }
}

/**
 * How many arguments the template requires: the highest N referenced as a
 * bare `$N`, since a missing one would be an empty string. `${N:-default}`
 * and `${@:N}` slices are optional and do not count.
 */
export function requiredArgs(template: string): number {
  let max = 0
  for (const [, n] of template.matchAll(/\$(\d+)/gu)) max = Math.max(max, Number(n))
  return max
}

/**
 * Fill a template's placeholders with arguments, as pi's `substituteArgs`
 * does. Only the template is scanned: placeholders inside arguments and
 * defaults stay as they are.
 */
export function substituteArgs(template: string, args: readonly string[]): string {
  const all = args.join(' ')
  return template.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/gu,
    (_match, defaultTarget?: string, fallback?: string, sliceStart?: string, sliceLength?: string, simple?: string) => {
      if (defaultTarget !== undefined) {
        const value = defaultTarget === '@' || defaultTarget === 'ARGUMENTS' ? all : args[Number(defaultTarget) - 1]
        return value !== undefined && value !== '' ? value : fallback ?? ''
      }
      if (sliceStart !== undefined) {
        // Arguments count from 1; ${@:0} starts at the first, as in bash.
        const start = Math.max(Number(sliceStart) - 1, 0)
        return (sliceLength === undefined ? args.slice(start) : args.slice(start, start + Number(sliceLength))).join(' ')
      }
      if (simple === '@' || simple === 'ARGUMENTS') return all
      return args[Number(simple) - 1] ?? ''
    },
  )
}

/** The body after a leading `---` frontmatter block, trimmed, as pi reads a template; the whole file when it has none. */
export function stripFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
  if (!normalized.startsWith('---')) return normalized
  const end = normalized.indexOf('\n---', 3)
  return end === -1 ? normalized : normalized.slice(end + 4).trim()
}
