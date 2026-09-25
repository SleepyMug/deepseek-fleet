#!/usr/bin/env node
/**
 * Stable link target for the `fleet-setup` bin, forwarding to the build
 * product. A package manager links a bin only when its target exists at
 * install time, and `lib/` is a build product absent on a clean checkout, so
 * this committed file is the target.
 * @module fleet-setup/bin
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const entry = new URL('./lib/cli.js', import.meta.url)
if (!existsSync(fileURLToPath(entry))) {
  process.stderr.write('fleet-setup: lib/cli.js is missing; build fleet-setup first\n')
  process.exit(1)
}
await import(entry.href)
