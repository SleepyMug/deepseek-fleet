/**
 * Where fleet's things lie in a box, which the host, the helper, and the
 * services and harnesses that use a box agree on. It holds constants only.
 * @module @sleepymug/fleet-protocol/layout
 */

import { posix } from 'node:path'

/** fleet-box, the helper's package, in the image, as it would be packed: its package.json and lib/. */
export const PACKAGE_ROOT = '/opt/fleet'

/** The Node the helper runs on: the base image's, which every program in a box can run on too. */
export const HELPER_NODE = '/usr/local/bin/node'

/** The helper, fleet-box's lib/helper/main.js. */
export const HELPER_ENTRY = `${PACKAGE_ROOT}/lib/helper/main.js`

/** Where each service's package is in a box, as `<name>@<digest>`, its name a link to the one in use. */
export const SERVICES_DIR = `${PACKAGE_ROOT}/services`

/** Where a service's package is in a box: the link to the one in use. */
export function serviceDir(name: string): string {
  return posix.join(SERVICES_DIR, name)
}

/** The folder of the services' commands, each a link to its service's `bin`, on the PATH of every process the helper starts. */
export const BIN_DIR = `${PACKAGE_ROOT}/bin`

/** Where each service's socket is in a box, `<name>.sock`, which the helper relays to the service. */
export const SOCKETS_DIR = '/run/fleet/services'

/** Where a service's socket is in a box. */
export function socketOf(name: string): string {
  return posix.join(SOCKETS_DIR, `${name}.sock`)
}

/**
 * Where the box's channel to the host is, a folder of the host's mounted in
 * the box, the one thing of the host's it has (./channel.ts).
 */
export const CHANNEL_DIR = '/run/fleet/host'

/** The channel's socket, which the host listens on, and the helper connects to. */
export const CHANNEL = `${CHANNEL_DIR}/channel.sock`

/** Names {@link SOCKETS_DIR} for every process the helper starts, so that a service's command finds its socket. */
export const SERVICES_VARIABLE = 'FLEET_SERVICES'

/** The tag `fleet image build` builds, and the image a box runs unless told otherwise. */
export const DEFAULT_IMAGE = 'fleet:local'
