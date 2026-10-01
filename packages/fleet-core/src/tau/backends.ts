/**
 * The fleet host's backends (`ctx.fleetBackends`): what fleet's API
 * implementations in a session's container (fleet-image's apis/) call on the host,
 * through fleet-box's service socket, for what they cannot do in the
 * container, such as keeping state or holding credentials. A backend is a
 * plugin's named set of methods, each with a schema of its arguments:
 *
 * ```ts
 * const dispose = ctx.fleetBackends.provide({
 *   name: 'notes',
 *   methods: { byTag: method(z.tuple([z.string()]), ([tag], { session }) => …) },
 * })
 * ctx.effect(() => dispose)
 * ```
 *
 * A call comes from the container, where the agent can send anything, so a
 * method runs only with arguments its schema accepts, and returns JSON, or
 * nothing for null. A call runs until the program that made it goes away, or
 * until the backend's time, if it sets one, runs out.
 * Calls come from fleet-tau's relay (./relay.ts), only for a backend that an
 * API the session's agent links calls, and an agent is run only when those
 * backends are provided (./prepare.ts).
 * @module fleet-core/tau/backends
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetBackends: FleetBackends
  }
}

/** What a method learns about the call. */
export interface BackendCall {
  /** The session whose container the call came from. */
  session: SessionId
  /** Aborts when the program goes away, the call runs out of time, or the backend is removed. */
  signal: AbortSignal
}

/** One method of a backend: what it takes, checked before it runs, and what it does. */
export interface BackendMethod<Args extends unknown[] = unknown[]> {
  args: z.ZodType<Args>
  /** Returns JSON, or nothing for null. */
  run(args: Args, call: BackendCall): unknown
}

/** A method whose arguments `args` checks, and types. */
export function method<Args extends unknown[]>(args: z.ZodType<Args>, run: (args: Args, call: BackendCall) => unknown): BackendMethod<Args> {
  return { args, run }
}

export interface Backend {
  /** What implementations call it by. */
  name: string
  /** How long a call may take before it is cancelled; no limit by default. */
  timeoutMs?: number
  // A method is typed by its own arguments; bivariance lets them share a record.
  methods: Record<string, BackendMethod<any>>
}

interface Provided extends Backend {
  /** Aborts the backend's calls in flight when it is removed. */
  removed: AbortController
}

export class FleetBackends extends Service {
  private readonly backends = new Map<string, Provided>()

  constructor(ctx: Context) {
    super(ctx, 'fleetBackends')
  }

  /**
   * Provide a backend until the returned removal.
   * @throws when a backend of its name is provided already.
   */
  provide(backend: Backend): () => void {
    if (this.backends.has(backend.name)) throw new Error(`fleet-tau: the backend ${backend.name} is provided already`)
    const entry: Provided = { ...backend, methods: { ...backend.methods }, removed: new AbortController() }
    this.backends.set(backend.name, entry)
    return () => {
      if (this.backends.get(backend.name) !== entry) return
      this.backends.delete(backend.name)
      entry.removed.abort(new Error(`the backend ${backend.name} is no longer provided`))
    }
  }

  /** The names of the backends provided now, sorted. */
  list(): string[] {
    return [...this.backends.keys()].sort()
  }

  /**
   * Call a method of a backend for a session.
   * @throws when nothing provides it, its arguments do not fit, it fails, or it runs out of time.
   */
  async call(session: SessionId, request: { service: string; function: string; args: unknown[] }, signal: AbortSignal): Promise<unknown> {
    const where = `${request.service}.${request.function}`
    const backend = this.backends.get(request.service)
    if (backend === undefined) throw new Error(`nothing provides the backend ${request.service} now`)
    if (!Object.hasOwn(backend.methods, request.function)) throw new Error(`the backend ${request.service} has no method ${request.function}`)
    const { args: schema, run } = backend.methods[request.function]!
    const parsed = schema.safeParse(request.args)
    if (!parsed.success) throw new Error(`${where}: its arguments do not fit: ${z.prettifyError(parsed.error).replace(/\n\s*/gu, ' ')}`)
    const { timeoutMs } = backend
    const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
    const cancelled = AbortSignal.any([signal, backend.removed.signal, ...timeout === undefined ? [] : [timeout]])
    try {
      return await abortable(Promise.resolve().then(() => run(parsed.data, { session, signal: cancelled })), cancelled) ?? null
    } catch (error) {
      if (timeout?.aborted === true) throw new Error(`${where} ran longer than ${(timeoutMs ?? 0) / 1000} s and was cancelled`)
      throw error
    }
  }
}

/** Stop waiting for an operation when the signal aborts; the operation is told through the same signal. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', aborted) })
  })
}

export default FleetBackends
