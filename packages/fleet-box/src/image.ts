/**
 * The session image as fleet-box relies on it: where the helper and its Node
 * are, and the label that says which protocol the helper speaks. The image
 * is built outside dsh, by `fleet-setup image` from the fleet-setup
 * package, from parts the packages ship, this helper's among them
 * ({@link helperPart}). fleet-box's `image` setting names it; fleet-box
 * never builds, pulls or removes an image, and only checks at startup that
 * the one named is there and carries this helper's protocol.
 * @module fleet-box/image
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from './helper/protocol.ts'

export { PROTOCOL_VERSION }

/** The image fleet-box uses unless its `image` setting names another; `fleet-setup image` tags this one by default. */
export const DEFAULT_IMAGE = 'fleet-box:local'

/**
 * The helper's Node, a copy of the image's, so a Node the model installs or
 * removes does not change it. The helper names its process `fleet-box`, so a
 * `pkill node` misses it too.
 */
export const HELPER_NODE = '/opt/fleet-box/bin/fleet-box'
export const HELPER_ENTRY = '/opt/fleet-box/helper/main.js'

/** The image label that carries the helper's {@link PROTOCOL_VERSION}. */
export const PROTOCOL_LABEL = 'fleet-box.protocol'

/** This package's folder. */
const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url))

/**
 * The helper as `fleet-setup image` builds it: image/helper holds its
 * manifest, lockfile and tsconfig, and src/helper its sources, which import
 * nothing from the rest of fleet-box. The image installs it, with a copy of
 * Node, under /opt/fleet-box.
 */
export function helperPart(): { build: string; sources: string; labels: Record<string, string> } {
  return { build: join(PACKAGE_DIR, 'image', 'helper'), sources: join(PACKAGE_DIR, 'src', 'helper'), labels: { [PROTOCOL_LABEL]: String(PROTOCOL_VERSION) } }
}
