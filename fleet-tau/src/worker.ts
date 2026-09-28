/**
 * The worker that reads agent directories for the fleet host (./prepare.ts),
 * so the TypeScript that tau's library loads never runs in the host's own
 * thread. It answers each message with the result for the same id.
 * @module fleet-tau/worker
 */

import { parentPort } from 'node:worker_threads'
import { prepare, type PrepareRequest } from './prepare.ts'

/** A job for the worker. */
export interface Job {
  id: number
  request: PrepareRequest
}

/** The worker's answer to a job. */
export type Answer = { id: number; result: ReturnType<typeof prepare> } | { id: number; error: string }

const port = parentPort
if (port === null) throw new Error('fleet-tau: worker.js runs only as a worker thread')
port.on('message', ({ id, request }: Job) => {
  let answer: Answer
  try {
    answer = { id, result: prepare(request) }
  } catch (error) {
    answer = { id, error: error instanceof Error ? error.message : String(error) }
  }
  port.postMessage(answer)
})
