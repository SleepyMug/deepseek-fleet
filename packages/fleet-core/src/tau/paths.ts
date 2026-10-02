/**
 * Where a session's container shows its agent and the agent's path
 * arguments. The agent's snapshot is copied to /tau/agent, which the prompt
 * names as `${self}`. The agent works in a folder of the container's own
 * that has its project's path (./store.ts), where tau puts each path
 * argument at its place, as tau.json declares it, and the prompt names it
 * there: an `in` path is a snapshot copied there, and an `out` path is what
 * the agent leaves there, which is copied out once the run completes.
 * Nothing else of the caller's is in the container, and the caller's paths
 * may be any the caller can read or write.
 *
 * A run started inside a session's container (./children.ts) works in its
 * caller's project, and places its paths as any run does, while the caller's
 * paths are in the caller's container, which the host never resolves.
 * @module fleet-core/tau/paths
 */

import { TAU_ROOT } from 'fleet-image/layout'

/** Where a session's container sees its agent's snapshot. */
export const AGENT_VIEW = `${TAU_ROOT}/agent`
