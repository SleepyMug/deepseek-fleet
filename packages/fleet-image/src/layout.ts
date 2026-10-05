/**
 * Where fleet's runtime lies in the image, which the host and the image
 * agree on. Shared by both, so it holds only constants.
 * @module fleet-image/layout
 */

/** This package in the image, as it would be packed: its package.json and lib/. */
export const PACKAGE_ROOT = '/opt/fleet'

/** The Node the helper runs on: the base image's. */
export const HELPER_NODE = '/usr/local/bin/node'

/** The helper, ./helper/main.ts. */
export const HELPER_ENTRY = `${PACKAGE_ROOT}/lib/helper/main.js`

/** The runtime's side of a tau's run, ./tau/main.ts, run on {@link HELPER_NODE}. */
export const TAU_ENTRY = `${PACKAGE_ROOT}/lib/tau/main.js`

/**
 * The socket the helper serves in the box, for the calls an extension's
 * client makes to its server on the host (./helper/cmd/calls.ts), unless
 * {@link SOCKET_VARIABLE} names another.
 */
export const CALL_SOCKET = '/run/fleet/calls.sock'

/** Names the call socket for every process the helper starts, and so for the clients in them. */
export const SOCKET_VARIABLE = 'FLEET_SOCKET'

/** The tag `pnpm image` builds, and the image a box runs unless told otherwise. */
export const DEFAULT_IMAGE = 'fleet:local'
