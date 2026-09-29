/**
 * How the host starts fleet-tau's TypeScript runner in a session container
 * (./main.ts), and what it asks and answers: one JSON request on the
 * runner's stdin, one JSON reply on its stdout, per run. Shared by the host,
 * whose tools start the runner, and the runner, so it holds only types and
 * constants.
 * @module fleet-tau-runner/protocol
 */

/**
 * The runner's ./main.ts in the container, where `fleet-setup image` puts
 * this package's lib/, run by the helper's own Node (fleet-box-helper/image's
 * HELPER_NODE).
 */
export const RUNNER_ENTRY = '/opt/fleet/runner/main.js'

/**
 * Version of this protocol. The session image carries the version of the
 * runner it holds in {@link RUNNER_PROTOCOL_LABEL}, which the tools check
 * before they start it.
 */
export const RUNNER_PROTOCOL = 1

/** The image label that carries the runner's {@link RUNNER_PROTOCOL}. */
export const RUNNER_PROTOCOL_LABEL = 'fleet-tau.runner-protocol'

/**
 * The session's TypeScript root in the container: where ts-executor keeps
 * each run's workspace, and the runner a copy of each service's package for
 * the model to read. It is the container's own, so it lasts as long as the
 * container.
 */
export const TS_ROOT = '/opt/fleet/ts'

/** Most bytes of a reply; the runner shrinks what it reports to fit. */
export const MAX_REPLY_BYTES = 1024 * 1024

/** A service a program may import as `@svc/<name>`, calling it through $TAU_SOCKET. */
export interface ServiceModule {
  name: string
  description?: string
  /** The service's canonical declarations, every function returning a Promise. */
  declarations: string
  functions: string[]
}

/** A package the agent ships, importable by its name. */
export interface AgentModule {
  name: string
  description?: string
  /** The package's folder in the container. */
  root: string
}

/** What every request says about the program's world. */
interface Packages {
  /** The TypeScript root, {@link TS_ROOT} in a container. */
  root: string
  services: ServiceModule[]
  modules: AgentModule[]
}

export type RunnerRequest =
  /** List the packages a program may import, filtered by `query` as ts-executor filters them. */
  | Packages & { command: 'modules'; query?: string }
  /** Type-check and run one program, killed after `timeoutMs`. */
  | Packages & { command: 'execute'; source: string; cwd: string; input?: unknown; timeoutMs: number }

/** One package a program may import. */
export interface ModuleSummary {
  specifier: string
  packageRoot: string
  description?: string
}

/** A failure as the runner reports it; everything in it is bounded. */
export interface RunnerFailure {
  name: string
  message: string
  diagnostics?: { category: string; code: number; message: string; file?: string; line?: number; column?: number }[]
  diagnosticsOmitted?: number
  stdout?: string
  stderr?: string
}

export type RunnerReply =
  | { ok: true; modules: ModuleSummary[] }
  | { ok: true; value: unknown; stdout: string; stderr: string; durationMs: number }
  | { ok: false; error: RunnerFailure }
