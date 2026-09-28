/**
 * How the host starts fleet-box's TypeScript runner in a session container
 * (./main.ts), and what it asks and answers: one JSON request on the
 * runner's stdin, one JSON reply on its stdout, per run. Shared by the host,
 * whose tools start the runner, and the runner, so it holds only types and
 * constants.
 * @module fleet-box/runner/protocol
 */

/** The runner's entry in the container, run by the helper's own Node (./image.ts's HELPER_NODE). */
export const RUNNER_ENTRY = '/opt/fleet-box/runner/main.js'

/**
 * The session's TypeScript package root in the container: its package.json
 * lists what `ts_install` added, whose packages programs import from its
 * node_modules. It is the container's own, so it lasts as long as the container.
 */
export const TS_ROOT = '/opt/fleet/ts'

/** A registry package's name, scoped or not, with an optional version, range or tag. */
const PACKAGE_SPEC = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[A-Za-z0-9._~^<>=| *-]+)?$/u

/**
 * Whether `install` accepts a package spec: a registry package, as
 * {@link PACKAGE_SPEC} has it. Paths, URLs, tarballs, git shorthands,
 * aliases and flags are refused, so npm looks the package up in its registry.
 */
export function isPackageSpec(spec: string): boolean {
  return PACKAGE_SPEC.test(spec) && !/\.(?:tgz|tar|tar\.gz)$/u.test(packageName(spec))
}

/** The name of a package spec, without its version. */
export function packageName(spec: string): string {
  const at = spec.indexOf('@', 1)
  return at === -1 ? spec : spec.slice(0, at)
}

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
  /** The package root, {@link TS_ROOT} in a container. */
  root: string
  services: ServiceModule[]
  modules: AgentModule[]
}

export type RunnerRequest =
  /** List the packages a program may import, filtered by `query` as ts-executor filters them. */
  | Packages & { command: 'modules'; query?: string }
  /** Type-check and run one program, killed after `timeoutMs`. */
  | Packages & { command: 'execute'; source: string; cwd: string; input?: unknown; timeoutMs: number }
  /** Add packages to the package root with npm, killed after `timeoutMs`. */
  | { command: 'install'; root: string; packages: string[]; timeoutMs: number }

/** One package a program may import. */
export interface ModuleSummary {
  specifier: string
  packageRoot: string
  description?: string
}

/** One package `install` added, and whether it brings its own type declarations. */
export interface Installed {
  name: string
  version: string
  typed: boolean
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
  | { ok: true; installed: Installed[]; log: string }
  | { ok: false; error: RunnerFailure }
