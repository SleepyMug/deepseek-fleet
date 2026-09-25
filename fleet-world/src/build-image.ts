/**
 * Build the session image, a prerequisite of fleet-world, which does not
 * start until it exists. Run it again after changing the image's
 * inputs, which gives the image a new tag; a tag already built is kept.
 * Docker gets exactly the inputs as its build context, and the result must
 * run the same dsh-ssh helper as the host, or its tag is removed again.
 * Older fleet-world tags are removed once no container uses them, so running
 * it again later clears those that were still in use.
 *
 * Usage: `node lib/build-image.js`, or `pnpm build-image`.
 * @module fleet-world/build-image
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { HELPER_ENTRY, HELPER_NODE, IMAGE_DIR, IMAGE_INPUTS, helperHash, imageTag } from './image.ts'

/** Prints the SHA-256 of the file named by its argument, as the helper's handshake computes it. */
const HASH_SCRIPT = 'process.stdout.write(require("node:crypto").createHash("sha256")'
  + '.update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))'

async function main(): Promise<void> {
  const tag = await imageTag()
  if (await docker(['image', 'inspect', '--format', '{{.Id}}', tag]).then(() => true, () => false)) {
    console.log(`fleet-world: ${tag} is already built`)
  } else {
    await buildChecked(tag)
  }
  await removeOlder(tag)
}

async function buildChecked(tag: string): Promise<void> {
  console.log(`fleet-world: building ${tag}`)
  await build(tag)
  const inImage = await docker(['run', '--rm', '--network', 'none', '--entrypoint', HELPER_NODE, tag, '-e', HASH_SCRIPT, HELPER_ENTRY])
  if (inImage !== await helperHash()) {
    await docker(['image', 'rm', tag])
    throw new Error('fleet-world: the image\'s dsh-ssh helper differs from the host\'s; pin the host\'s @deepseek-ai/dsh-ssh '
      + 'version in image/helper/package.json and its lockfile, then build again')
  }
  console.log(`fleet-world: built ${tag}`)
}

/** Remove every other fleet-world tag; Docker refuses those a container still uses, and they stay. */
async function removeOlder(tag: string): Promise<void> {
  const tags = (await docker(['image', 'ls', '--filter', 'reference=fleet-world', '--format', '{{.Repository}}:{{.Tag}}']))
    .split('\n').filter(line => line !== '' && line !== tag)
  for (const older of tags) {
    try {
      await docker(['image', 'rm', older])
      console.log(`fleet-world: removed ${older}`)
    } catch {
      console.log(`fleet-world: kept ${older}, which a container still uses`)
    }
  }
}

/** Send the inputs to `docker build` as a tar stream, so the context holds nothing else. */
async function build(tag: string): Promise<void> {
  const tar = spawn('tar', ['-c', '-f', '-', '-C', IMAGE_DIR, '--', ...IMAGE_INPUTS], { stdio: ['ignore', 'pipe', 'inherit'] })
  const builder = spawn('docker', ['build', '--tag', tag, '-'], { stdio: ['pipe', 'inherit', 'inherit'] })
  tar.stdout.pipe(builder.stdin)
  await Promise.all([exited(tar, 'tar'), exited(builder, 'docker build')])
}

function exited(child: ChildProcess, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`fleet-world: ${name} failed (${signal ?? `exit ${String(code)}`})`))
    })
  })
}

/** @returns trimmed stdout; a failure carries Docker's stderr. */
function docker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, (error, stdout, stderr) => {
      if (error === null) resolve(stdout.trim())
      else reject(new Error(`fleet-world: docker ${args[0] ?? ''} failed: ${stderr.trim() || error.message}`, { cause: error }))
    })
  })
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
