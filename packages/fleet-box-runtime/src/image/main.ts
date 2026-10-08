#!/usr/bin/env node
/**
 * `fleet-box-image [<tag>]`: build the box image (./build.ts) from this
 * package as installed, so run it from the install the host runs, as that
 * of the profile fleet-core is in: `dsh plugin --profile web exec fleet-box-image`.
 * `pnpm image` at the workspace root runs it too.
 * @module @sleepymug/fleet-box-runtime/image/main
 */

import { parseArgs } from 'node:util'
import { DEFAULT_IMAGE } from '../layout.ts'
import { buildImage } from './build.ts'

const USAGE = `Usage: fleet-box-image [<tag>]

Build the box image from this package as installed, with Docker, and tag it
<tag>, ${DEFAULT_IMAGE} by default.
`

try {
  const { values, positionals } = parseArgs({ options: { help: { type: 'boolean', short: 'h' } }, allowPositionals: true })
  if (values.help === true) {
    process.stdout.write(USAGE)
  } else if (positionals.length > 1) {
    process.stderr.write('fleet-box-image: takes one tag at most\nRun `fleet-box-image --help` for how.\n')
    process.exitCode = 2
  } else {
    await buildImage({ tag: positionals[0] })
  }
} catch (error) {
  const usage = (error as { code?: unknown }).code?.toString().startsWith('ERR_PARSE_ARGS') === true
  process.stderr.write(`${usage ? 'fleet-box-image: ' : ''}${error instanceof Error ? error.message : String(error)}${usage ? '\nRun `fleet-box-image --help` for how.' : ''}\n`)
  process.exitCode = usage ? 2 : 1
}
