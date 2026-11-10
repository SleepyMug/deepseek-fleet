/**
 * The fleet host, as the runs build on it ({@link FleetPort}), through its
 * client: its boxes, each made with what a run's box needs, and asked of as
 * fleet-client's `FleetBox`.
 * @module @sleepymug/dsh-tau/tau/fleet
 */

import type { FleetClient } from '@sleepymug/fleet-client'
import type { FleetPort } from './ports.ts'

export function fleetOf(client: FleetClient): FleetPort {
  return {
    create: async spec => (await client.create(spec)).id,
    box: id => client.box(id),
    services: () => client.request('service.list', {}),
  }
}
