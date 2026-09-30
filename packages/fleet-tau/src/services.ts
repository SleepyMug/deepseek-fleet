/**
 * The services fleet's plugins provide to agents (`ctx.fleetServices`), for
 * programs in a session's container to call through fleet-box's service
 * socket. A provider is a manifest, a `.d.ts` file as tau specifies one
 * (@sleepymug/tau's SPEC.md), whose name names the service, and a function
 * for each function it declares:
 *
 * ```ts
 * const dispose = await ctx.fleetServices.provide({ manifest, functions: { addNote: ([text, tags], { session }) => … } })
 * ctx.effect(() => dispose)
 * ```
 *
 * A call reaches its function only with arguments the manifest accepts,
 * reduced to what it declares, and its result is checked the same way; one
 * that runs past the provider's time is cancelled. Where the manifest
 * declares a `Uint8Array`, the function takes and gives one, which the wire
 * carries as base64. Calls come from fleet-tau's relay (./relay.ts), only
 * for a function the session's agent declares, and an agent is run only
 * when its declarations fit what is provided (./compat.ts), so both sides'
 * manifests hold for every call.
 * @module fleet-tau/services
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue, Service as Manifest, Value } from '@sleepymug/tau'
import type { Declared } from './compat.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    fleetServices: FleetServices
  }
}

/** How long a call may take unless its provider says otherwise. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000

/** What a provided function learns about the call. */
export interface ServiceCall {
  /** The root session whose container the call came from. */
  session: SessionId
  /** Aborts when the program goes away, the call runs out of time, or the provider is removed. */
  signal: AbortSignal
}

/**
 * One function of a service; its arguments fit the manifest, and it returns
 * what the manifest declares, or nothing for null: JSON's values, and bytes
 * as a `Uint8Array` where the manifest declares one.
 */
export type ServiceFunction = (args: Value[], call: ServiceCall) => Value | undefined | Promise<Value | undefined>

export interface ServiceProvider {
  /** The manifest, an absolute path to `<service>.d.ts`. */
  manifest: string
  /** How long a call may take before it is cancelled; ten minutes by default. */
  timeoutMs?: number
  /** A function for each function the manifest declares, and no others. */
  functions: Record<string, ServiceFunction>
}

/** A provided service, as `fleet services` lists it. */
export interface ProvidedService extends Declared {
  description: string | undefined
}

interface Provider {
  manifest: Manifest
  timeoutMs: number
  functions: Record<string, ServiceFunction>
  /** Aborts the provider's calls in flight when it is removed. */
  removed: AbortController
}

export class FleetServices extends Service {
  private readonly providers = new Map<string, Provider>()

  constructor(ctx: Context) {
    super(ctx, 'fleetServices')
  }

  /**
   * Provide a service until the returned removal. tau's library, and with it
   * TypeScript, loads with the first provider, so a host with none never loads them.
   * @throws when the manifest is not one tau accepts, its functions and the given ones differ, or its service is provided already.
   */
  async provide(provider: ServiceProvider): Promise<() => void> {
    const { loadService } = await import('@sleepymug/tau')
    const manifest = loadService(provider.manifest)
    if (this.providers.has(manifest.name)) throw new Error(`fleet-tau: the service ${manifest.name} is provided already`)
    const given = Object.keys(provider.functions)
    const missing = manifest.functions.filter(fn => !given.includes(fn))
    const extra = given.filter(fn => !manifest.functions.includes(fn))
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(`fleet-tau: the provider of ${manifest.name} must give exactly the functions ${provider.manifest} declares`
        + `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}${extra.length > 0 ? `; not declared: ${extra.join(', ')}` : ''}`)
    }
    const entry: Provider = { manifest, timeoutMs: provider.timeoutMs ?? DEFAULT_TIMEOUT_MS, functions: { ...provider.functions }, removed: new AbortController() }
    this.providers.set(manifest.name, entry)
    return () => {
      if (this.providers.get(manifest.name) !== entry) return
      this.providers.delete(manifest.name)
      entry.removed.abort(new Error(`the service ${manifest.name} is no longer provided`))
    }
  }

  /** The services provided now, by name. */
  list(): ProvidedService[] {
    return [...this.providers.values()]
      .map(({ manifest }) => ({ name: manifest.name, description: manifest.description, declarations: manifest.declarations, functions: [...manifest.functions] }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  /**
   * Call a provided function for a session.
   * @throws when nothing provides it, its arguments or result do not fit the manifest, it fails, or it runs out of time.
   */
  async call(session: SessionId, request: { service: string; function: string; args: unknown[] }, signal: AbortSignal): Promise<JsonValue> {
    const provider = this.providers.get(request.service)
    if (provider === undefined) throw new Error(`nothing provides the service ${request.service} now`)
    if (!Object.hasOwn(provider.functions, request.function)) throw new Error(`the service ${request.service} has no function ${request.function}`)
    const fn = provider.functions[request.function]!
    const args = provider.manifest.decodeArguments(request.function, request.args as JsonValue[])
    const timeout = AbortSignal.timeout(provider.timeoutMs)
    const cancelled = AbortSignal.any([signal, timeout, provider.removed.signal])
    let result: Value | undefined
    try {
      result = await abortable(Promise.resolve().then(() => fn(args, { session, signal: cancelled })), cancelled)
    } catch (error) {
      if (timeout.aborted) throw new Error(`${request.service}.${request.function} ran longer than ${provider.timeoutMs / 1000} s and was cancelled`)
      throw error
    }
    return provider.manifest.encodeResult(request.function, result ?? null)
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

export default FleetServices
