/**
 * The APIs a session's programs import as `@api/<name>`, and so the
 * backends they may call (./relay.ts), each with where the container has its
 * declarations, and the packages of its agent's own they import beside them.
 * A session started from an agent directory has the APIs its agent
 * declares, typed by the agent's own declarations in its snapshot, and
 * those its agent exposes, with its packages, are what its programs are
 * given; the others are for its packages. Any other, as one the web UI
 * starts, or a prompt run, has fleet's `tau` API, typed by fleet's
 * declarations of it, as if it ran an agent that declares and exposes only
 * that one, so that it can run taus. Nothing of that is stored: the session
 * keeps its container as it is, and its spec, if it has one, has no APIs.
 * @module fleet-core/tau/apis
 */

import { posix } from 'node:path'
import { implementation } from 'fleet-image/apis/registry'
import { AGENT_VIEW } from './paths.ts'
import type { Spec, SpecApi, SpecPackage } from './spec.ts'

/** The API of a session not started from an agent directory. */
export const DEFAULT_API = 'tau'

/** An API of a session. */
export interface SessionApi extends SpecApi {
  /** Its declarations in the container, which type `@api/<name>`. */
  types: string
}

/**
 * The APIs of a session.
 * @param spec - the spec of the session that owns its container (./store.ts), if it has one.
 */
export function sessionApis(spec: Spec | undefined): SessionApi[] {
  if (spec?.agent !== undefined) return spec.apis.map(api => ({ ...api, types: posix.join(AGENT_VIEW, 'api', `${api.name}.d.ts`) }))
  const found = implementation(DEFAULT_API)
  if (found === undefined) throw new Error(`fleet no longer implements the API ${DEFAULT_API}`)
  return [{
    name: found.name,
    ...found.description === undefined ? {} : { description: found.description },
    backends: [...found.backends],
    exposed: true,
    types: found.imageTypes,
  }]
}

/** A package of a session's agent that its programs are given. */
export interface SessionPackage extends SpecPackage {
  /** Its folder in the container, in the agent's snapshot. */
  root: string
}

/**
 * The packages of a session's agent that its programs are given.
 * @param spec - the spec of the session that owns its container (./store.ts), if it has one.
 */
export function sessionPackages(spec: Spec | undefined): SessionPackage[] {
  if (spec?.agent === undefined) return []
  return spec.packages.map(found => ({ ...found, root: posix.join(AGENT_VIEW, 'node_modules', found.specifier) }))
}
