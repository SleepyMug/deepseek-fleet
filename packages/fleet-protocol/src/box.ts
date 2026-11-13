/**
 * A box's API, fleet.box.v1 (proto/fleet/box/v1), which its helper serves:
 * `Box`, its processes, terminals and files, which the gateway carries to
 * it from its clients; and `Provision`, which the gateway alone asks.
 * @module @sleepymug/fleet-protocol/box
 */

export * from './gen/fleet/box/v1/box_pb.ts'
export * from './gen/fleet/box/v1/provision_pb.ts'
