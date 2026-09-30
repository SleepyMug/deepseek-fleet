/**
 * Archives folders with the fleet host: each is packed as a tarball and
 * sent there, and the host keeps a receipt of what it received. Each session
 * has receipts of its own, kept while the fleet host runs.
 *
 * @packageDocumentation
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { call } from '../client.ts'

/** What the fleet host received. */
export interface Receipt {
  /** The name it was sent under. */
  name: string
  /** The tarball's size in bytes. */
  bytes: number
  /** Its SHA-256, in hex. */
  sha256: string
  /** The paths it holds, in its order, as tar lists them without a leading `./`; folders end in `/`. */
  entries: string[]
}

/**
 * Pack a folder into a tarball, its paths relative to the folder, and send
 * it to the fleet host. A receipt kept under the same name is replaced.
 * @param dir - The folder to send.
 * @param name - What to keep its receipt under; the folder's own name by default.
 */
export async function archiveDir(dir: string, name: string = path.basename(path.resolve(dir))): Promise<Receipt> {
  // The socket carries JSON, so the tarball crosses as base64.
  return await call('archives', 'store', [name, (await tarball(dir)).toString('base64')]) as Receipt
}

/** The receipts kept, oldest first. */
export async function list(): Promise<Receipt[]> {
  return await call('archives', 'list', []) as Receipt[]
}

/** The folder as an uncompressed tarball, which the session image's tar writes. */
function tarball(dir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-cf', '-', '-C', dir, '.'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    tar.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    tar.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    tar.on('error', reject)
    tar.on('close', (code, signal) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`tar could not pack ${dir} (${signal ?? `exit ${String(code)}`}): ${stderr.trim()}`))
    })
  })
}
