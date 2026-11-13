/**
 * `@sleepymug/fleet/gateway`: the gateway, for a process of one's own
 * choosing, as `fleet serve` (./cli/main.ts) and a test run one.
 * - {@link FleetGateway}, put together from its home, its driver and its
 *   platform, and {@link serve}, which serves it on its sockets.
 * - {@link DockerDriver} and {@link LocalDriver}, where its boxes are.
 * @module @sleepymug/fleet/gateway
 */

export { FleetGateway, type BoxListener, type GatewayDeps } from './gateway.ts'
export { serve, type Serving, type Sockets } from './http/server.ts'
export { fleetPaths, type FleetPaths } from './home.ts'
export { systemPlatform, type Platform } from './platform.ts'
export type { BoxDriver, ContainerSpec, ContainerState } from './boxes/driver.ts'
export { DockerDriver, BOX_LABEL } from './boxes/docker.ts'
export { LocalDriver } from './boxes/local.ts'
