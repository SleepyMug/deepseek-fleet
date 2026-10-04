/**
 * `pnpm image [tag]`: build the box image (./build.ts).
 * @module fleet-image/image/main
 */

import { buildImage } from './build.ts'

try {
  await buildImage({ tag: process.argv[2] })
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
