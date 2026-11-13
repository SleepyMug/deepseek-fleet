/**
 * `@sleepymug/fleet-service-client`: what a service's client in a box runs on,
 * as fleet-codegen makes it.
 * - {@link schema} and {@link serviceClient}: a service's methods, called
 *   through the box's services socket.
 * - {@link toMessage}, {@link toPlain} and {@link wellKnown}: plain
 *   objects, as the client's declarations have them, to and from protobuf
 *   messages; fleet-codegen declares what they convert to.
 * @module @sleepymug/fleet-service-client
 */

export { CallError, schema, serviceClient, type ServicePlace } from './client.ts'
export { isLong, toMessage, toPlain, wellKnown, type WellKnown } from './plain.ts'
