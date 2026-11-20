/**
 * Where fleet's things lie in a box, which the gateway, the helper and the
 * programs in the box agree on. The image holds the helper alone, at
 * {@link IMAGE_DIR}; what the box's services bring, the gateway installs at
 * `/fleet` as the box first starts, and the helper serves them all on one
 * socket. A layout may be rooted elsewhere, as a test runs a helper outside
 * a container.
 * @module @sleepymug/fleet-protocol/layout
 */

import { posix } from 'node:path'

/** fleet-box, the helper's package, in the image, as it would be packed. */
export const IMAGE_DIR = '/opt/fleet'

/** The Node the helper runs on, the base image's, which a box's programs run on too. */
export const HELPER_NODE = '/usr/local/bin/node'

/** The helper, fleet-box's lib/helper/main.js. */
export const HELPER_ENTRY = `${IMAGE_DIR}/lib/helper/main.js`

/** The image a box runs unless told otherwise, which `fleet image build` tags. */
export const DEFAULT_IMAGE = 'fleet:local'

/** The scope of the services' clients' packages: `@fleet/<name>`. */
export const CLIENT_SCOPE = '@fleet'

/** The helper's environment: the socket of the gateway it dials. */
export const GATEWAY_VARIABLE = 'FLEET_GATEWAY'

/** The helper's environment: the token of the box it serves, by which the gateway knows its calls are the box's. */
export const TOKEN_VARIABLE = 'FLEET_BOX_TOKEN'

/** The helper's environment: where the layout is rooted, `/` without it, as outside a container. */
export const ROOT_VARIABLE = 'FLEET_BOX_ROOT'

/** Every process's environment in a box: the socket its programs reach the services on. */
export const SERVICES_SOCKET_VARIABLE = 'FLEET_SERVICES_SOCKET'

/** Where things are in a box. */
export interface BoxLayout {
  /** What the box's services bring, which the gateway installs: `/fleet`. */
  readonly fleet: string
  /** The services' commands, first on the PATH of every process: `/fleet/bin`. */
  readonly bin: string
  /** Each service's own package, by its name: `/fleet/services/<name>`. */
  readonly services: string
  /** The services' clients, `@fleet/<name>`, and what they import: `/fleet/node_modules`. */
  readonly modules: string
  /** What the box has, and how a program uses it: `/fleet/README.md`. */
  readonly readme: string
  /** The one socket the box's programs reach every service on: `/run/fleet/services.sock`. */
  readonly servicesSocket: string
  /** The folder of the gateway's own socket, mounted in the box, which the helper dials: `/run/fleet/gateway`. */
  readonly gatewayDir: string
}

/** The layout, rooted at `root`. */
export function boxLayout(root = '/'): BoxLayout {
  const at = (path: string): string => posix.join(root, path)
  return {
    fleet: at('/fleet'),
    bin: at('/fleet/bin'),
    services: at('/fleet/services'),
    modules: at('/fleet/node_modules'),
    readme: at('/fleet/README.md'),
    servicesSocket: at('/run/fleet/services.sock'),
    gatewayDir: at('/run/fleet/gateway'),
  }
}

/** The box's own layout. */
export const BOX_LAYOUT: BoxLayout = boxLayout()

/** The gateway's socket in its folder, {@link BoxLayout.gatewayDir}. */
export const GATEWAY_SOCKET = 'gateway.sock'

/** The package name of a service's client. */
export function clientPackage(service: string): string {
  return `${CLIENT_SCOPE}/${service}`
}

/**
 * Where things are in what the gateway installs at {@link BoxLayout.fleet},
 * relative to it: the tree it composes for a box's services.
 */
export const TREE = {
  bin: 'bin',
  services: 'services',
  modules: 'node_modules',
  readme: 'README.md',
} as const
