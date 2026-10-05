/**
 * Where a run's caller has its files. `fleet`, on the host, names host paths,
 * which the runs read and write as they are. A tau's session, from its box,
 * names paths in that box, which the model controls, so nothing it names is
 * read on the host where it is: the tau's directory and each `$in` and
 * `$inout` handle are copied out of the box, whole, to a staging folder on
 * the host, and checked there as tau's library checks any; the folder of
 * each `$out` handle is checked in the box; and what the run gives back is
 * put in the box (./outputs.ts).
 * @module fleet-core/tau/callers
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { checkInputs, type BoundHandle, type Run } from '@sleepymug/tau'
import { MissingInBox } from '../box/box.ts'
import { hostTarget, type Target } from './outputs.ts'

/** What the runs do with a calling session's box, each in turn with its other operations (./runs.ts). */
export interface CallerBox {
  copyOutWhole(from: string, to: string): Promise<void>
  copyInWhole(from: string, to: string): Promise<void>
  /** Run a program, started box and all; an exit other than 0 is a result. */
  exec(argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }>
}

export interface CallerFiles {
  /** Where the host reads the tau's directory, which the caller names. */
  tau(dir: string): Promise<string>
  /**
   * Check a run's handles against the caller's files, as tau's
   * docs/spec/paths.md asks before a run.
   * @returns where the host reads what each `$in` and `$inout` handle names, by the handle's index.
   * @throws listing every problem.
   */
  inputs(run: Run): Promise<Map<number, string>>
  /** Where what a run gives back is put. */
  target: Target
}

/** `fleet`'s files, on the host. */
export const hostFiles: CallerFiles = {
  tau: dir => Promise.resolve(dir),
  inputs(run) {
    checkInputs(run)
    return Promise.resolve(new Map([...run.handles.entries()].filter(([, handle]) => handle.mode !== 'out').map(([index, handle]) => [index, handle.host])))
  },
  target: hostTarget,
}

/**
 * A calling session's files, in its box.
 * @param staging - a folder of the run's own on the host, for the copies, which the caller removes.
 */
export function boxFiles(box: CallerBox, staging: string): CallerFiles {
  return {
    async tau(dir) {
      const here = join(staging, 'self')
      await mkdir(staging, { recursive: true, mode: 0o700 })
      await copyOut(box, dir, here, `fleet: there is no tau at ${dir}`)
      // Its links must stay inside it, as an `$in` folder's, or reading it would read the host's files.
      try {
        checkInputs({ prompt: '', values: {}, handles: [{ at: 'the tau', mode: 'in', kind: 'dir', host: here, view: '' }] })
      } catch (error) {
        throw new Error(`fleet: the tau at ${dir} cannot run: ${named((error as Error).message.split('\n').slice(1).join('; ').trim(), [[here, dir]])}`, { cause: error })
      }
      return here
    },
    async inputs(run) {
      const problems: string[] = []
      const staged = new Map<number, string>()
      await mkdir(join(staging, 'in'), { recursive: true, mode: 0o700 })
      for (const [index, handle] of run.handles.entries()) {
        if (handle.mode === 'out') {
          problems.push(...await outProblems(box, handle))
          continue
        }
        const here = join(staging, 'in', String(index))
        try {
          await box.copyOutWhole(handle.host, here)
          staged.set(index, here)
        } catch (error) {
          if (!(error instanceof MissingInBox)) throw error
          problems.push(`${handle.at}: ${handle.host} does not exist`)
        }
      }
      const copies = [...staged].map(([index, host]) => ({ ...run.handles[index] as BoundHandle, host }))
      try {
        checkInputs({ ...run, handles: copies })
      } catch (error) {
        const renames = [...staged].reverse().map(([index, host]): [string, string] => [host, (run.handles[index] as BoundHandle).host])
        problems.push(...(error as Error).message.split('\n').slice(1).map(line => named(line.trim(), renames)))
      }
      if (problems.length > 0) throw new Error(`the handles do not fit the tau:\n  ${problems.join('\n  ')}`)
      return staged
    },
    target: {
      async resolve(path) {
        const { code, stdout } = await box.exec(['realpath', '-m', '--', path])
        return code === 0 && stdout.trim() !== '' ? stdout.trim() : path
      },
      async isFolder(path) {
        return (await box.exec(['sh', '-c', '[ -d "$1" ] && [ ! -L "$1" ]', 'sh', path])).code === 0
      },
      async replace(from, to) {
        const cleared = await box.exec(['sh', '-c', 'rm -rf -- "$1" && mkdir -p -- "$(dirname -- "$1")"', 'sh', to])
        if (cleared.code !== 0) throw new Error(`fleet: could not make way for ${to} in the caller's box: ${cleared.stderr.trim()}`)
        await box.copyInWhole(from, to)
      },
    },
  }
}

/** Copy a path out of the box, whole; nothing there fails with `missing`. */
async function copyOut(box: CallerBox, from: string, to: string, missing: string): Promise<void> {
  try {
    await box.copyOutWhole(from, to)
  } catch (error) {
    if (error instanceof MissingInBox) throw new Error(missing, { cause: error })
    throw error
  }
}

/**
 * Why an `$out` handle cannot go where its path is in the box, as tau's
 * `checkInputs` says it on the host: its folder must be there, and the path
 * not there yet, or of its kind, symlinks followed.
 */
const OUT_CHECK = `
parent=$(dirname -- "$1")
if [ ! -e "$parent" ]; then echo "cannot go in $parent, which does not exist"; exit 0; fi
if [ ! -d "$parent" ]; then echo "cannot go in $parent, which is not a directory"; exit 0; fi
[ -e "$1" ] || exit 0
case $2 in
  file) [ -f "$1" ] || echo "$1 is not a file";;
  dir) [ -d "$1" ] || echo "$1 is not a directory";;
  *) [ -f "$1" ] || [ -d "$1" ] || echo "$1 is neither a file nor a directory";;
esac
`

async function outProblems(box: CallerBox, handle: BoundHandle): Promise<string[]> {
  const { code, stdout, stderr } = await box.exec(['sh', '-c', OUT_CHECK, 'sh', handle.host, handle.kind])
  if (code !== 0) return [`${handle.at}: ${handle.host} cannot be checked: ${stderr.trim()}`]
  return stdout.split('\n').filter(line => line !== '').map(line => `${handle.at}: ${line}`)
}

/** A problem with each staged copy named as the caller names it. */
function named(problem: string, renames: readonly [string, string][]): string {
  return renames.reduce((text, [staged, caller]) => text.replaceAll(staged, caller), problem)
}
