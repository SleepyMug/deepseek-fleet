/**
 * fleet's gateway, as the runs build on it ({@link FleetPort}), through
 * fleet-sdk: its boxes, each made with what a run's box needs, and asked of
 * as fleet-sdk's `FleetBox`, its state named as the runs name it.
 * @module @sleepymug/dsh-tau/tau/fleet
 */

import { BoxState as State, type Fleet, type FleetBox } from '@sleepymug/fleet-sdk'
import type { BoxState, FleetBoxPort, FleetPort } from './ports.ts'

const STATES: Readonly<Record<number, BoxState>> = {
  [State.STOPPED]: 'stopped',
  [State.STARTING]: 'starting',
  [State.STARTED]: 'started',
  [State.STOPPING]: 'stopping',
  [State.GONE]: 'gone',
}

export function fleetOf(client: Fleet): FleetPort {
  return {
    create: async spec => (await client.create(spec)).id,
    box: id => boxOf(client.box(id)),
    services: async () => (await client.serviceList()).map(({ name, description, commands }) => ({ name, description, commands })),
  }
}

function boxOf(box: FleetBox): FleetBoxPort {
  return {
    id: box.id,
    api: box.api,
    started: box.started,
    services: async () => (await box.info()).services,
    lease: (occupant, options) => box.lease(occupant, options),
    watch: listener => box.watch(state => listener(state === 'removed' ? 'removed' : STATES[state] ?? 'stopped')),
    start: () => box.start(),
    stop: () => box.stop(),
    stopWhenVacant: () => box.stopWhenVacant(),
    remove: () => box.remove(),
    put: (archive, to) => box.put(archive, to),
    get: from => box.get(from),
  }
}
