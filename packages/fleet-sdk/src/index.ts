/**
 * `@sleepymug/fleet-sdk`: the gateway's client (./fleet.ts), its boxes
 * (./box.ts), a service served to it (./serve.ts), who calls a service
 * (./caller.ts), and the gateway's failures (./errors.ts).
 * @module @sleepymug/fleet-sdk
 */

export { Fleet, type ConnectOptions } from './fleet.ts'
export { BoxState, FleetBox, type BoxListener, type ExecOptions } from './box.ts'
export type { Registration, ServiceDefinition } from './serve.ts'
export { boxOf, callerOf } from './caller.ts'
export { FleetUnreachable, Reason, reasonOf } from './errors.ts'
export { fleetHome, fleetSocket } from '@sleepymug/fleet-protocol/home'
export type { Box, Caller, Service } from '@sleepymug/fleet-protocol/gateway'
