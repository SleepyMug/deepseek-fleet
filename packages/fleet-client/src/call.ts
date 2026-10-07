/**
 * A run's call from the command line: `name=value` gives the file `name`
 * the path `value`, when the tau declares that file, and else the arg
 * `name` the string `value`; `name:=json` gives either as JSON: a file a
 * path, or, for an `in`, a list of paths; an arg any JSON, as tau's
 * docs/spec/calls.md has them. The call is checked against the tau when it
 * is packed, so a name the tau does not declare passes as an arg, for the
 * tau's schema to take or refuse.
 * @module fleet-client/call
 */

import type { FileDeclaration, Json } from '@sleepymug/tau'

/** A mistake in the command line, answered with a pointer to the usage. */
export class UsageError extends Error {}

/** A call, as the command line gives it. */
export interface Call {
  files: Record<string, unknown>
  args: Record<string, Json>
}

/**
 * @param args - the `name=value` and `name:=json` arguments.
 * @param files - the tau's files, as tau.json declares them.
 */
export function parseCall(args: readonly string[], files: { readonly [name: string]: FileDeclaration }): Call {
  const call: Call = { files: {}, args: {} }
  for (const arg of args) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(:?=)(.*)$/su.exec(arg)
    if (match === null) throw new UsageError(`${arg} is neither <name>=<value> nor <name>:=<json>`)
    const [, name, operator, text] = match
    const into = Object.hasOwn(files, name) ? call.files : call.args
    if (Object.hasOwn(into, name)) throw new UsageError(`${name} is given twice`)
    if (operator === '=') {
      into[name] = text
      continue
    }
    try {
      into[name] = JSON.parse(text) as Json
    } catch {
      throw new UsageError(`the value of ${name} is not JSON: ${text}`)
    }
  }
  return call
}
