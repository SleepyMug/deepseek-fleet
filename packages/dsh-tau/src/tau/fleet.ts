/**
 * fleet's gateway, as the runs build on it ({@link FleetPort}), through its
 * client: its boxes, each made with what a run's box needs, and asked of as
 * fleet-sdk's `FleetBox`.
 * @module @sleepymug/dsh-tau/tau/fleet
 */

import type { Fleet } from '@sleepymug/fleet-sdk'
import type { FleetPort } from './ports.ts'

export function fleetOf(client: Fleet): FleetPort {
  return {
    create: async spec => (await client.create(spec)).id,
    box: id => client.box(id),
    services: () => client.request('service.list', {}),
  }
}
