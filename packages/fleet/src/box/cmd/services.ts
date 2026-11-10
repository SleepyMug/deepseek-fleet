/**
 * The host's side of the box's services (fleet-box's helper/cmd/services):
 * the check of what the helper answers `services.installed` with, which the
 * helper connection registers (../helper.ts).
 * @module @sleepymug/fleet/box/cmd/services
 */

import type { Methods } from '@sleepymug/fleet-protocol/helper'

export function isInstalled(value: unknown): value is Methods['services.installed']['result'] {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(digests => Array.isArray(digests) && digests.every(digest => typeof digest === 'string'))
}
