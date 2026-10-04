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

/** The tag `pnpm image` builds, and the image a box runs unless told otherwise. */
export const DEFAULT_IMAGE = 'fleet:local'
