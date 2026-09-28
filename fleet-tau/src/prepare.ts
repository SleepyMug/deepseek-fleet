/**
 * Read an agent directory for a run or a check: its tau metadata and prompt,
 * the command's arguments bound to them, with its path arguments checked as
 * tau checks a run's inputs and where the container can give them
 * (./paths.ts), its skills, its modules, checked as tau checks them, and its
 * service manifests, checked against the services fleet provides
 * (./compat.ts), with every problem found reported together. tau's library loads
 * TypeScript as it is imported, so this runs in a worker (./worker.ts), never
 * in the fleet host's own thread.
 * @module fleet-tau/prepare
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { checkInputs, checkModule, loadModules, loadService, loadTau, TAU_SOCKET, type Module, type Run, type Service, type Tau } from '@sleepymug/tau'
import { checkServices, type Declared } from './compat.ts'
import { pathProblems } from './paths.ts'
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
  /** The session folder, as its real path, which no path argument may be, hold or lie in. */
  cwd: string
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
  if (tau.env.includes(TAU_SOCKET)) problems.push(`${tau.dir}/tau.json: env lists ${TAU_SOCKET}, which fleet sets itself`)
  let prompt = tau.prompt
  let run: Run | undefined
  if (request.bind) {
    try {
      run = tau.bind(request.args, { cwd: request.callerCwd, env: request.env })
      prompt = run.prompt
      if (prompt.trim() === '') problems.push(`${tau.dir}/PROMPT.md gives an empty prompt`)
    } catch (error) {
      problems.push(`${tau.dir}: ${message(error)}`)
    }
  }
  if (run !== undefined) {
    const placed = pathProblems(run.paths, request.cwd)
    problems.push(...placed)
    if (placed.length === 0) {
      try {
        checkInputs(run)
      } catch (error) {
        problems.push(message(error))
      }
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
      env: { ...run?.env },
      paths: (run?.paths ?? []).map(({ name, kind, mode, host, view }) => ({ name, kind, mode, host, view })),
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
