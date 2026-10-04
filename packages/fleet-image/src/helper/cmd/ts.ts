/**
 * `ts.execute` and `ts.cancel`: TypeScript programs, which fleet-core's
 * `ts_execute` tool runs in the box, with ts-executor. Each is type-checked,
 * strictly, against what it imports, then run in a fresh Node process of its
 * own, which calls its `main(input)`. Its packages resolve from `root`, as
 * Node finds them from the run's folder ts-executor makes below it: for a
 * tau, /tau, whose node_modules holds its APIs (./link.ts). The modules it
 * is given are only what ts-executor lists; what resolves is what Node
 * finds. ts-executor is loaded with the first program, so the helper starts
 * without TypeScript.
 * @module fleet-image/helper/cmd/ts
 */

import { isAbsolute } from 'node:path'
import type { Methods, TsFailure, TsOutcome } from '../protocol.ts'

type Params = Methods['ts.execute']['params']

/** Each execution running, by the host's id, which `ts.cancel` aborts. */
const running = new Map<string, AbortController>()

export async function tsExecute(params: Params): Promise<TsOutcome> {
  const { execution, root, modules, source, cwd } = checked(params)
  if (running.has(execution)) throw new Error(`execution ${execution} already exists`)
  const controller = new AbortController()
  running.set(execution, controller)
  let stdout = ''
  let stderr = ''
  try {
    const { TSFuncExecutor, packageModule } = await import('@sleepymug/ts-executor')
    const executor = new TSFuncExecutor({ resolutionRoot: root })
    for (const { specifier, root: folder, description } of modules) {
      executor.modules.register(packageModule({ specifier, root: folder, ...description === undefined ? {} : { description } }))
    }
    const result = await executor.execute({
      source,
      cwd,
      // JSON from the host, so a JSON value.
      ...Object.hasOwn(params, 'input') ? { input: params.input as never } : {},
      signal: controller.signal,
      onStdout: (text) => { stdout += text },
      onStderr: (text) => { stderr += text },
    })
    return { ok: true, value: result.value, stdout, stderr, durationMs: Math.round(result.durationMs) }
  } catch (error) {
    return { ok: false, error: failure(error), stdout, stderr }
  } finally {
    running.delete(execution)
  }
}

export function tsCancel({ execution }: Methods['ts.cancel']['params']): null {
  running.get(String(execution))?.abort()
  return null
}

/** Abort every execution, as the helper exits; each then answers. */
export function cancelAll(): void {
  for (const controller of running.values()) controller.abort()
}

/** ts-executor's own failures, whose stacks are its own, not the program's. */
const EXECUTOR_FAILURES = new Set(['TypeCheckError', 'ExecutionAbortedError'])

function failure(error: unknown): TsFailure {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  const diagnostics = (error as { diagnostics?: TsFailure['diagnostics'] }).diagnostics
  return {
    name: error.name,
    message: error.message,
    ...error.stack === undefined || EXECUTOR_FAILURES.has(error.name) ? {} : { stack: error.stack },
    ...diagnostics === undefined ? {} : { diagnostics: diagnostics.map(diagnostic => ({ ...diagnostic })) },
  }
}

function checked(params: Params): Params {
  const { execution, root, modules, source, cwd } = (params ?? {}) as Partial<Params>
  if (typeof execution !== 'string') throw new TypeError('ts.execute takes an execution, a string')
  if (typeof root !== 'string' || !isAbsolute(root)) throw new TypeError('ts.execute takes a root, an absolute path')
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new TypeError('ts.execute takes a cwd, an absolute path')
  if (typeof source !== 'string') throw new TypeError('ts.execute takes a source, a string')
  const isModule = (module: unknown): boolean => {
    const { specifier, root: folder, description } = (module ?? {}) as Record<string, unknown>
    return typeof specifier === 'string' && typeof folder === 'string' && isAbsolute(folder) && (description === undefined || typeof description === 'string')
  }
  if (!Array.isArray(modules) || !modules.every(isModule)) throw new TypeError('ts.execute takes modules, a list of { specifier, root, description? }')
  return { execution, root, modules, source, cwd }
}
