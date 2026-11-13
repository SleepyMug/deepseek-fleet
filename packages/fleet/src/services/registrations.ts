/**
 * The services registered now: each a spec, and the tunnel its server
 * opened naming it, for as long as the tunnel lasts. One server a name: a
 * tunnel for a name another serves now is refused.
 * @module @sleepymug/fleet/services/registrations
 */

import type { AcceptedTunnel, Upstream } from '@sleepymug/fleet-net'
import { nameTaken } from '../failure.ts'
import type { Spec } from './specs.ts'

/** A service registered. */
export interface Registration {
  readonly spec: Spec
  /** Where its calls go: its server, through its tunnel. */
  readonly upstream: Upstream
}

export class Registrations {
  private readonly live = new Map<string, Registration>()

  /**
   * @param onChange - told the name of each service registered or gone.
   */
  constructor(private readonly onChange: (name: string, registration: Registration | undefined) => void = () => {}) {}

  /** Register `spec` for as long as `tunnel` lasts. */
  register(spec: Spec, tunnel: AcceptedTunnel): Registration {
    if (this.live.has(spec.name)) throw nameTaken(spec.name)
    const registration: Registration = { spec, upstream: tunnel.upstream }
    this.live.set(spec.name, registration)
    this.onChange(spec.name, registration)
    void tunnel.closed.then(() => {
      if (this.live.get(spec.name) !== registration) return
      this.live.delete(spec.name)
      this.onChange(spec.name, undefined)
    })
    return registration
  }

  get(name: string): Registration | undefined {
    return this.live.get(name)
  }

  /** Every service registered, by name. */
  list(): Registration[] {
    return [...this.live.values()].sort((a, b) => (a.spec.name < b.spec.name ? -1 : 1))
  }
}
