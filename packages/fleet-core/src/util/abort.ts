/**
 * @module @sleepymug/fleet-core/util/abort
 */

/** Stop waiting for a promise when the signal aborts; what it waits for goes on. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}
