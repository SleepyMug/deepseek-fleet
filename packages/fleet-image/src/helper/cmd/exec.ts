/**
 * `exec`: run a program in the box, as the container's root, without a
 * shell, and answer how it ended and all it wrote to stdout and stderr. An
 * exit other than 0, or a signal, is an answer, not a failure; a program that
 * cannot run at all, such as one that is not there, is a failure.
 * @module fleet-image/helper/cmd/exec
 */

import { execFile } from 'node:child_process'
import type { Methods } from '../protocol.ts'

type Exec = Methods['exec']

export function exec(params: Exec['params']): Promise<Exec['result']> {
  const argv: unknown = params?.argv
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(arg => typeof arg === 'string')) {
    throw new Error('exec takes an argv, a list of strings, the program first')
  }
  const [file, ...args] = argv as string[]
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: Infinity }, (error, stdout, stderr) => {
      if (error === null) resolve({ code: 0, signal: null, stdout, stderr })
      else if (typeof error.code === 'number' || typeof error.signal === 'string') {
        resolve({ code: typeof error.code === 'number' ? error.code : null, signal: error.signal ?? null, stdout, stderr })
      } else reject(new Error(`exec cannot run ${file}: ${error.message}`))
    })
  })
}
