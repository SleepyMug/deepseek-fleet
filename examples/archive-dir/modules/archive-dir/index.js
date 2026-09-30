// The archives service takes a tarball, as bytes; this module takes a directory, and packs it with
// tar, which the session image carries.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { store } from '@svc/archives'

export async function archiveDir(dir, name = path.basename(path.resolve(dir))) {
  return store(name, await tarball(dir))
}

/** The directory as an uncompressed tarball, as `tar -cf` writes one. */
function tarball(dir) {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-cf', '-', '-C', dir, '.'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let stderr = ''
    tar.stdout.on('data', chunk => chunks.push(chunk))
    tar.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    tar.on('error', reject)
    tar.on('close', (code, signal) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`tar -cf ${dir} failed (${signal ?? `exit ${code}`}): ${stderr.trim()}`))
    })
  })
}
