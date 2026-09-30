/**
 * Whether the services fleet's plugins provide satisfy the services an agent
 * declares, checked ahead of any call: each declared service has a
 * provider, each declared function exists there, and the provider's function
 * fits the declared one, as TypeScript decides: it accepts every argument
 * list the agent's manifest allows, and returns only what the agent's
 * manifest promises. So an agent may declare only some of a service's
 * functions, with narrower parameters or a wider result, and a call its
 * manifest allows is one the provider's manifest accepts.
 *
 * Both sides are compared in their manifests as written, which tau has
 * proved to mean what their JSON Schema means, in one program over files in
 * a temporary folder. It runs where tau's library is loaded, in fleet-tau's
 * worker.
 * @module fleet-tau/compat
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'

/** A service as its manifest declares it. */
export interface Declared {
  name: string
  /** The manifest as written. */
  declarations: string
  functions: readonly string[]
}

/** As tau reads manifests; strict, so parameters compare contravariantly. */
const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  lib: ['lib.es2022.d.ts'],
}

/** Lines of a TypeScript message kept in a problem. */
const MESSAGE_LINES = 4

/**
 * @param required - the services an agent declares.
 * @param provided - the services fleet's plugins provide.
 * @returns a problem for each way the provided services fall short, none when they satisfy the agent.
 */
export function checkServices(required: readonly Declared[], provided: readonly Declared[]): string[] {
  const problems: string[] = []
  const pairs: { required: Declared; provided: Declared; functions: string[] }[] = []
  for (const service of required) {
    const provider = provided.find(candidate => candidate.name === service.name)
    if (provider === undefined) {
      problems.push(`no fleet plugin provides the service ${service.name}`)
      continue
    }
    const functions: string[] = []
    for (const fn of service.functions) {
      if (provider.functions.includes(fn)) functions.push(fn)
      else problems.push(`${service.name}.${fn}: the provided ${service.name} has no function ${fn}`)
    }
    if (functions.length > 0) pairs.push({ required: service, provided: provider, functions })
  }
  if (pairs.length > 0) problems.push(...checkTypes(pairs))
  return problems
}

/** Type-check each provided function against its declared one, in one program. */
function checkTypes(pairs: readonly { required: Declared; provided: Declared; functions: string[] }[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-tau-compat-'))
  try {
    const lines: string[] = []
    /** What each line of the check file compares, by line. */
    const subjects = new Map<number, string>()
    pairs.forEach((pair, index) => {
      writeFileSync(join(dir, `required${index}.d.ts`), pair.required.declarations)
      writeFileSync(join(dir, `provided${index}.d.ts`), pair.provided.declarations)
      lines.push(`import type * as R${index} from "./required${index}.js";`, `import type * as P${index} from "./provided${index}.js";`)
    })
    pairs.forEach((pair, index) => {
      for (const fn of pair.functions) {
        subjects.set(lines.length, `${pair.required.name}.${fn}`)
        const id = lines.length
        lines.push(`declare const p${id}: typeof P${index}.${fn}; export const c${id}: typeof R${index}.${fn} = p${id};`)
      }
    })
    const checkFile = join(dir, 'check.mts')
    writeFileSync(checkFile, `${lines.join('\n')}\n`)
    const program = ts.createProgram([checkFile], OPTIONS)
    const problems: string[] = []
    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
      const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').split('\n').slice(0, MESSAGE_LINES).map(line => line.trim()).join(' ')
      const file = diagnostic.file
      const subject = file?.fileName === checkFile && diagnostic.start !== undefined
        ? subjects.get(file.getLineAndCharacterOfPosition(diagnostic.start).line)
        : undefined
      problems.push(subject === undefined
        ? `the service manifests could not be compared: ${text}`
        : `${subject}: the provided function does not fit the declared one: ${text}`)
    }
    return problems
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
