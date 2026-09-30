/**
 * The session image as fleet-box relies on it: where the helper and its Node
 * are, and the label that says which protocol the helper speaks. The image
 * is built outside dsh, by `fleet-setup image`, which installs this package
 * in it with the packages it depends on, as they are installed on the host.
 * fleet-box's `image` setting names it; fleet-box never builds, pulls or
 * removes an image, and only checks at startup that the one named is there
 * and carries this helper's protocol.
 * @module fleet-image/helper/image
 */

import { PROTOCOL_VERSION } from './protocol.ts'

export { PROTOCOL_VERSION }

/** The image fleet-box uses unless its `image` setting names another; `fleet-setup image` tags this one by default. */
export const DEFAULT_IMAGE = 'fleet-box:local'

/**
 * The helper's Node, a copy of the image's, so a Node the model installs or
 * removes does not change it. The helper names its process `fleet-box`, so a
 * `pkill node` misses it too.
 */
export const HELPER_NODE = '/opt/fleet-box/bin/fleet-box'
/** The helper's ./main.ts, which the image holds with the rest of this package's lib/ at /opt/fleet-box. */
export const HELPER_ENTRY = '/opt/fleet-box/helper/main.js'

/** The image label that carries the helper's {@link PROTOCOL_VERSION}. */
export const PROTOCOL_LABEL = 'fleet-box.protocol'
