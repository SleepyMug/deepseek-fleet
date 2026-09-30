/**
 * The folders of a session container that are fleet's own, which the host
 * and the image agree on: every path of fleet's in a container lies in one
 * of them, and the host keeps what it adds to a container, and the paths an
 * agent's arguments name, out of them. The image's Dockerfile, beside this
 * package's src/, fills {@link PACKAGE_ROOT}; `fleet setup image` checks a
 * build where the host will look before it tags it. Shared by the host and
 * the image, so it holds only constants.
 * @module fleet-image/layout
 */

/** This package in the session image: its lib/ at the top, beside its package.json and node_modules. */
export const PACKAGE_ROOT = '/opt/fleet-box'

/** What the helper makes as it runs: its service socket (./helper/protocol.ts). */
export const RUN_ROOT = '/run/fleet-box'

/**
 * fleet-tau's folder in a container, which the image leaves empty: the
 * agent's snapshot, which the host copies in, and the runner's TypeScript
 * root (./runner/protocol.ts).
 */
export const TAU_ROOT = '/opt/fleet-tau'
