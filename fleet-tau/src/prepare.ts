/**
 * Read an agent directory for a run or a check: its tau metadata and prompt,
 * the command's arguments bound to them, its skills, its modules, checked as
 * tau checks them, and its service manifests, checked against the services
 * fleet provides (./compat.ts), with every problem found reported together. tau's library loads
 * TypeScript as it is imported, so this runs in a worker (./worker.ts), never
 * in the fleet host's own thread.
 * @module fleet-tau/prepare
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { checkModule, loadModules, loadService, loadTau, type Module, type Service, type Tau } from '@sleepymug/tau'
import { checkServices, type Declared } from './compat.ts'
import { loadSkills } from './skills.ts'
import { SPEC_VERSION, type Spec } from './spec.ts'

export interface PrepareRequest {
  /** The agent directory, absolute. */
  agent: string
  /** The command's arguments to the agent. */
  args: string[]
  /** Whether to bind the arguments: always for a run, and for a check only when it was given some. */
  bind: boolean
  /** The command's working folder, which relative path arguments are resolved against. */
  callerCwd: string
  /** The command's values of the variables the agent's tau.json lists. */
  env: Record<string, string>
  /** The services fleet's plugins provide now. */
  providers: Declared[]
  /** Whether the session gets the TypeScript tools even when the agent declares no services and ships no modules. */
  ts?: boolean
}

export type Prepared =
  | { ok: true; spec: Spec; title: string }
  | { ok: false; problems: string[] }

export function prepare(request: PrepareRequest): Prepared {
  let tau: Tau
  try {
    tau = loadTau(request.agent)
  } catch (error) {
    return { ok: false, problems: [message(error)] }
  }
  const problems: string[] = []
  const metadata = `${tau.dir}/tau.json`
  for (const arg of tau.args) {
    if (arg.kind !== 'text') problems.push(`${metadata}: ${arg.name} is a ${arg.kind === 'dir' ? 'folder' : 'file'} argument, which fleet does not provide yet`)
  }
  if (tau.env.length > 0) problems.push(`${metadata}: env lists ${tau.env.join(', ')}, and fleet does not pass environment variables to its agents yet`)
  let prompt = tau.prompt
  if (request.bind) {
    try {
      prompt = tau.bind(request.args, { cwd: request.callerCwd, env: request.env }).prompt
      if (prompt.trim() === '') problems.push(`${tau.dir}/PROMPT.md gives an empty prompt`)
    } catch (error) {
      problems.push(`${tau.dir}: ${message(error)}`)
    }
  }
  const skills = loadSkills(tau.dir)
  problems.push(...skills.problems)
  const modules = checkedModules(tau.dir, problems)
  const services = loadManifests(tau.dir, problems)
  problems.push(...checkServices(services.map(service => ({ name: service.name, declarations: service.declarations, functions: service.functions })), request.providers))
  if (problems.length > 0) return { ok: false, problems }
  const name = basename(tau.dir)
  return {
    ok: true,
    spec: {
      version: SPEC_VERSION,
      agent: { name, source: tau.dir },
      args: request.args,
      prompt,
      skills: skills.skills,
      services: Object.fromEntries(services.map(service => [service.name, {
        ...service.description === undefined ? {} : { description: service.description },
        declarations: service.declarations,
        functions: [...service.functions],
      }])),
      modules: modules.map(module => ({
        name: module.name,
        ...module.description === undefined ? {} : { description: module.description },
        dir: relative(join(tau.dir, 'modules'), module.root),
      })),
      ts: request.ts === true || services.length > 0 || modules.length > 0,
    },
    title: [name, ...request.args].join(' '),
  }
}

/** The agent's modules, each of whose imports resolves as tau checks it; each problem is reported. */
function checkedModules(dir: string, problems: string[]): Module[] {
  let modules: Module[]
  try {
    modules = loadModules(dir)
  } catch (error) {
    problems.push(message(error))
    return []
  }
  return modules.filter((module) => {
    try {
      checkModule(module)
      return true
    } catch (error) {
      problems.push(message(error))
      return false
    }
  })
}

/** Every `services/*.d.ts` that tau accepts; each one it refuses is a problem. */
function loadManifests(dir: string, problems: string[]): Service[] {
  const folder = join(dir, 'services')
  if (!existsSync(folder)) return []
  const services: Service[] = []
  for (const file of readdirSync(folder).filter(name => name.endsWith('.d.ts')).sort()) {
    try {
      services.push(loadService(join(folder, file)))
    } catch (error) {
      problems.push(message(error))
    }
  }
  return services
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
