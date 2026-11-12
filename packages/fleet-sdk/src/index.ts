/**
 * `@sleepymug/fleet-sdk`: the fleet host's client (./client.ts), and the
 * wire's types it speaks (fleet-protocol).
 * @module @sleepymug/fleet-sdk
 */

export { FleetBox, Fleet, FleetError, FleetUnreachable, type ClientOptions, type Registration, type ServiceDefinition } from './client.ts'
export {
  BOX_GONE, fleetHome, fleetSocket, NO_BOX, NOT_STARTED,
  type BoxInfo, type BoxSpec, type BoxState, type Occupant, type Preamble, type ServiceInfo,
} from '@sleepymug/fleet-protocol/fleet'
export type { EventOf, Method, Methods, Target } from '@sleepymug/fleet-protocol/helper'
