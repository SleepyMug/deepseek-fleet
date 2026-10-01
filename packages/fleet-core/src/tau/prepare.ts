/**
 * Read an agent directory for a run or a check: its tau metadata and prompt,
 * the command's arguments bound to them, with its path arguments placed
 * where the container shows them, as is the agent directory, which
 * `${self}` names, and checked as tau checks a run's inputs and as the
 * container can give them (./paths.ts), its skills, and its APIs, each
 * linked to fleet's implementation of the same name
 * (fleet-image's apis/), which tau checks fits it, and whose backends must
 * be provided, with every problem found reported together. tau's library
 * loads TypeScript as it is imported, so this runs in a worker
 * (./worker.ts), never in the fleet host's own thread.
 *
 * A run started inside a session's container (./children.ts) reads a copy
 * of the agent directory, and its caller's paths are in that container, so
 * they are not checked here but when the run's spec is stored (./store.ts);
 * what is reported names the directory where the caller has it.
 * @module fleet-core/tau/prepare
 */

import { basename } from 'node:path'
import { checkImplementation, checkInputs, loadApis, loadTau, type Api, type Run, type Tau } from '@sleepymug/tau'
import { reservedVariable } from '../box/additions.ts'
import { implementation } from 'fleet-image/apis/registry'
import { AGENT_VIEW, nestedPathProblems, pathProblems, place, placeNested } from './paths.ts'
import { loadSkills } from './skills.ts'
import { SPEC_VERSION, type Spec, type SpecApi } from './spec.ts'

export interface PrepareRequest {
  /** The agent directory, absolute: where the caller has it, or a copy of it. */
  agent: string
  /** Where the caller has the agent directory, when `agent` is a copy of it. */
  source?: string
  /** The session from whose container the run is started, which has the caller's paths; none for a run started on the host. */
  caller?: string
  /** The command's arguments to the agent. */
  args: string[]
  /** Whether to bind the arguments: always for a run, and for a check only when it was given some. */
  bind: boolean
  /** The caller's working folder, which relative path arguments are resolved against. */
  callerCwd: string
  /** The caller's values of the variables the agent's tau.json lists; any others are left out. */
  env: Record<string, string>
  /** The backends fleet's plugins provide now. */
  backends: string[]
  /** The dsh home, where fleet keeps its sessions. */
  dshHome: string
}

export type Prepared =
  | { ok: true; spec: Spec; title: string }
  | { ok: false; problems: string[] }

export function prepare(request: PrepareRequest): Prepared {
  const prepared = prepareFrom(request)
  const { source } = request
  if (prepared.ok || source === undefined) return prepared
  return { ok: false, problems: prepared.problems.map(problem => problem.replaceAll(request.agent, source)) }
}

function prepareFrom(request: PrepareRequest): Prepared {
  const nested = request.caller !== undefined
  let tau: Tau
  try {
    tau = loadTau(request.agent)
  } catch (error) {
    return { ok: false, problems: [message(error)] }
  }
  const problems: string[] = []
  const reserved = tau.env.filter(reservedVariable)
  if (reserved.length > 0) problems.push(`${tau.dir}/tau.json: env lists ${reserved.join(', ')}, which the container keeps as its own`)
  let prompt = tau.prompt
  let run: Run | undefined
  if (request.bind) {
    try {
      run = tau.bind(request.args, { cwd: request.callerCwd, env: request.env }, nested ? placeNested : place, AGENT_VIEW)
      prompt = run.prompt
      if (prompt.trim() === '') problems.push(`${tau.dir}/PROMPT.md gives an empty prompt`)
    } catch (error) {
      problems.push(`${tau.dir}: ${message(error)}`)
    }
  }
  if (run !== undefined && nested) problems.push(...nestedPathProblems(run.paths))
  if (run !== undefined && !nested) {
    problems.push(...pathProblems(run.paths, request.dshHome))
    try {
      checkInputs(run)
    } catch (error) {
      problems.push(message(error))
    }
  }
  const skills = loadSkills(tau.dir)
  problems.push(...skills.problems)
  const apis = linkedApis(tau.dir, request.backends, problems)
  if (problems.length > 0) return { ok: false, problems }
  const source = request.source ?? tau.dir
  const name = basename(source)
  return {
    ok: true,
    spec: {
      version: SPEC_VERSION,
      agent: { name, source },
      ...request.caller === undefined ? {} : { caller: request.caller },
      args: request.args,
      prompt,
      skills: skills.skills,
      apis,
      env: { ...run?.env },
      paths: (run?.paths ?? []).map(({ name, type, role, host, view }) => ({ name, type, role, host, view })),
    },
    title: [name, ...request.args].join(' '),
  }
}

/**
 * The agent's APIs, each linked to fleet's implementation of the same name,
 * which must fit it as tau checks, and whose backends must be provided now;
 * each problem is reported.
 */
function linkedApis(dir: string, provided: readonly string[], problems: string[]): SpecApi[] {
  let apis: Api[]
  try {
    apis = loadApis(dir)
  } catch (error) {
    problems.push(message(error))
    return []
  }
  return apis.flatMap((api) => {
    const found = implementation(api.name)
    if (found === undefined) {
      problems.push(`${api.specifier}: fleet has no implementation of it; \`fleet apis\` lists the ones it has`)
      return []
    }
    try {
      checkImplementation(api, found.file)
    } catch (error) {
      problems.push(message(error))
      return []
    }
    const missing = found.backends.filter(backend => !provided.includes(backend))
    if (missing.length > 0) {
      problems.push(`${api.specifier}: fleet's implementation calls the backend ${missing.join(', ')}, which no fleet plugin provides now`)
      return []
    }
    return [{ name: api.name, ...api.description === undefined ? {} : { description: api.description }, backends: [...found.backends] }]
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
