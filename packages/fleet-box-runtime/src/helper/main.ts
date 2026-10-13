/**
 * The helper's process. The host starts it in a box with `docker exec
 * --interactive`, and it serves the host (./serve.ts) on its stdin and
 * stdout, in the box's environment and its working folder, until its stdin
 * ends; then it exits.
 * @module @sleepymug/fleet-box-runtime/helper/main
 */

import { serve } from './serve.ts'

// Node names its main thread `node-MainThread`, which a `pkill node` in the box would match.
process.title = 'fleet-helper'

try {
  await serve({
    input: process.stdin,
    output: process.stdout,
    env: process.env,
    cwd: process.cwd(),
    log: (message) => { process.stderr.write(`fleet-helper: ${message}\n`) },
  })
} finally {
  process.exit(0)
}
