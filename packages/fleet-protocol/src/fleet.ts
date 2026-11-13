/**
 * The gateway's API, fleet.v1 (proto/fleet/v1): `Boxes` and `Services`,
 * which its clients call, harnesses and services' servers; `Caller`, which
 * the gateway tells a service each call comes from; and `Failure`, why it
 * refused a call.
 * @module @sleepymug/fleet-protocol/fleet
 */

export * from './gen/fleet/v1/boxes_pb.ts'
export * from './gen/fleet/v1/caller_pb.ts'
export * from './gen/fleet/v1/failure_pb.ts'
export * from './gen/fleet/v1/services_pb.ts'
