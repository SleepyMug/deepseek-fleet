/**
 * How the host starts fleet-tau's TypeScript runner in a session container
 * (./main.ts), and what it asks and answers: one JSON request on the
 * runner's stdin, one JSON reply on its stdout, per run. Shared by the host,
 * whose tools start the runner, and the runner, so it holds only types and
 * constants.
 * @module fleet-image/runner/protocol
 */

import { PACKAGE_ROOT, TAU_ROOT } from '../layout.ts'

/**
 * The runner's ./main.ts in the container, with the rest of this package's
 * lib/, run by the helper's own Node (../helper/image.ts's HELPER_NODE).
 */
export const RUNNER_ENTRY = `${PACKAGE_ROOT}/runner/main.js`

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
 * each run's workspace, and the runner the packages that link the
 * session's APIs (./links.ts). It is the container's own, so it lasts as long as the
 * container.
 */
export const TS_ROOT = `${TAU_ROOT}/ts`

/**
 * The node_modules folder above the agent's snapshot (fleet-core's
 * tau/paths.ts) and {@link TS_ROOT}, where the runner links each API of the
 * session as `@api/<name>` (./links.ts), so that the agent's own packages,
 * which Node.js and TypeScript resolve from where they are in the snapshot,
 * import the implementation programs do (tau's SPEC.md, Implementations).
 */
export const API_MODULES = `${TAU_ROOT}/node_modules`

/** Most bytes of a reply; the runner shrinks what it reports to fit. */
export const MAX_REPLY_BYTES = 1024 * 1024

/** An API of the session, which the runner links for programs, and the agent's own packages, to import as `@api/<name>` (./links.ts). */
export interface LinkedApi {
  name: string
  /** Its description: the agent's, or fleet's for an API of fleet's own declarations. */
  description?: string
  /** Its declarations in the container, which type it: the agent's `api/<name>.d.ts`, or fleet's own, beside the implementation. */
  types: string
  /** fleet's implementation in the container, which runs it. */
  implementation: string
  /** Whether programs are given it, as the agent's tau.json `exposes` says, or else imports it only through the agent's own packages. */
  exposed: boolean
}

/** A package of the agent's own that programs are given (tau's SPEC.md, Packages). */
export interface AgentPackage {
  /** Its name, which programs import. */
  specifier: string
  description?: string
  /** Its folder in the agent's snapshot: `node_modules/<name>`, where Node.js finds it. */
  root: string
}

/** What every request says about the program's world. */
interface Packages {
  /** The TypeScript root, {@link TS_ROOT} in a container. */
  root: string
  /** Where the APIs are linked for the agent's own packages, {@link API_MODULES} in a container. */
  modules: string
  apis: LinkedApi[]
  packages: AgentPackage[]
}

export type RunnerRequest =
  /** List the packages a program may import, filtered by `query` as ts-executor filters them. */
  | Packages & { command: 'modules'; query?: string }
  /** Type-check and run one program, killed after `timeoutMs` if given, or else when the host cancels it. */
  | Packages & { command: 'execute'; source: string; cwd: string; input?: unknown; timeoutMs?: number }

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
