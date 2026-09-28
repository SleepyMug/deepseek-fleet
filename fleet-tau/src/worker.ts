/**
 * The worker that runs tau's library for the fleet host, so the TypeScript
 * it loads never runs in the host's own thread: it reads agent directories
 * (./prepare.ts) and checks what a run left (tau's `checkOutputs`). It
 * answers each job with the result for the same id.
 * @module fleet-tau/worker
 */

import { parentPort } from 'node:worker_threads'
import { checkOutputs, type BoundPath } from '@sleepymug/tau'
import { prepare, type PrepareRequest } from './prepare.ts'

/** What the worker is asked to do. */
export type Work =
  | { kind: 'prepare'; request: PrepareRequest }
  /** Check a run's outputs; `copies` gives, by view path, where each copy-out's copy is. */
  | { kind: 'outputs'; paths: BoundPath[]; copies: Record<string, string> }

/** A job for the worker: its work, and the id its answer carries. */
export type Job = Work & { id: number }

/** The worker's answer to a job. */
export type Answer = { id: number; result: unknown } | { id: number; error: string }

/** The problems tau finds with what a run left, none when it left what the tau declares. */
function outputProblems(paths: BoundPath[], copies: Record<string, string>): string[] {
  const run = { prompt: '', env: {}, paths, identity: paths.every(path => path.host === path.view) }
  try {
    checkOutputs(run, view => copies[view] ?? view)
    return []
  } catch (error) {
    const lines = (error instanceof Error ? error.message : String(error)).split('\n')
    return lines.length > 1 ? lines.slice(1).map(line => line.trim()) : lines
  }
}

const port = parentPort
if (port === null) throw new Error('fleet-tau: worker.js runs only as a worker thread')
port.on('message', (job: Job) => {
  let answer: Answer
  try {
    answer = { id: job.id, result: job.kind === 'prepare' ? prepare(job.request) : outputProblems(job.paths, job.copies) }
  } catch (error) {
    answer = { id: job.id, error: error instanceof Error ? error.message : String(error) }
  }
  port.postMessage(answer)
})
