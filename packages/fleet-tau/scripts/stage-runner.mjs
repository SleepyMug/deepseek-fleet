#!/usr/bin/env node
/**
 * Stage the TypeScript runner's dependency on @sleepymug/ts-executor for the
 * session image, while its 0.4.0 is not on npm: pack the checkout fleet-tau
 * links (../agent_fleet_project/ts-executor), building it first, into
 * image/runner/vendor/, where the runner's package.json depends on it as a
 * tarball, and refresh image/runner/npm-shrinkwrap.json with npm from the
 * image's own Node image, since npm need not be on this machine. Run it
 * after the checkout changes, then build the image with `fleet-setup image`.
 * The tarball is not committed; the shrinkwrap, with its digest, is.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The Node image the Dockerfile builds on, whose npm resolves the runner's dependencies. */
const NODE_IMAGE = 'node:26.9.0-trixie-slim'
const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url))
const RUNNER_DIR = join(PACKAGE_DIR, 'image', 'runner')
const VENDOR_DIR = join(RUNNER_DIR, 'vendor')

const checkout = realpathSync(join(PACKAGE_DIR, 'node_modules', '@sleepymug', 'ts-executor'))
const { version } = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'))
const tarball = `sleepymug-ts-executor-${version}.tgz`

rmSync(VENDOR_DIR, { recursive: true, force: true })
mkdirSync(VENDOR_DIR, { recursive: true })
execFileSync('pnpm', ['pack', '--pack-destination', VENDOR_DIR], { cwd: checkout, stdio: 'inherit' })

const manifestFile = join(RUNNER_DIR, 'package.json')
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
manifest.dependencies['@sleepymug/ts-executor'] = `file:vendor/${tarball}`
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

execFileSync('docker', [
  'run', '--rm', '--mount', `type=bind,src=${RUNNER_DIR},dst=/runner`, '--workdir', '/runner', NODE_IMAGE,
  'sh', '-c', 'npm install --package-lock-only --no-audit --no-fund --no-update-notifier && { [ -f npm-shrinkwrap.json ] || npm shrinkwrap; }',
], { stdio: 'inherit' })
process.stdout.write(`staged ${tarball} and refreshed image/runner/npm-shrinkwrap.json; build the image with \`fleet-setup image\`\n`)
