/**
 * A run's call from the command line: `name=value` gives the file `name`
 * the path `value`, when the tau declares that file, and else the arg
 * `name` the string `value`; `name:=json` gives either as JSON: a file a
 * path, or, for an `in`, a list of paths; an arg any JSON, as tau's
 * docs/spec/calls.md has them. `--in`, `--out` and `--inout` give a file
 * with that mode, `name=path` or `name:=json`, which is how a call gives an
 * extra file, one the tau does not declare. The call is checked against the
 * tau when it is packed, so a name the tau does not declare passes as an
 * arg, for the tau's schema to take or refuse.
 * @module @sleepymug/fleet-client/call
 */

import type { FileDeclaration, Json, Mode } from '@sleepymug/tau'

/** A mistake in the command line, answered with a pointer to the usage. */
export class UsageError extends Error {}

/** A call, as the command line gives it. */
export interface Call {
  files: Record<string, unknown>
  args: Record<string, Json>
}

/** The options that give a file with its mode, each `name=path` or `name:=json`, as parseArgs gives them. */
export type ModedFiles = { readonly [M in Mode]?: readonly string[] }

/** The options that give a file with its mode, for parseArgs. */
export const MODE_OPTIONS = {
  in: { type: 'string', multiple: true },
  out: { type: 'string', multiple: true },
  inout: { type: 'string', multiple: true },
} as const

/**
 * @param args - the `name=value` and `name:=json` arguments.
 * @param files - the tau's files, as tau.json declares them.
 * @param moded - the files given with their modes, by `--in`, `--out` and `--inout`.
 */
export function parseCall(args: readonly string[], files: { readonly [name: string]: FileDeclaration }, moded: ModedFiles = {}): Call {
  const call: Call = { files: {}, args: {} }
  const given = (name: string): void => {
    if (Object.hasOwn(call.files, name) || Object.hasOwn(call.args, name)) throw new UsageError(`${name} is given twice`)
  }
  for (const arg of args) {
    const [name, value] = parse(arg)
    given(name)
    if (Object.hasOwn(files, name)) call.files[name] = value
    else call.args[name] = value
  }
  for (const mode of ['in', 'out', 'inout'] as const) {
    for (const arg of moded[mode] ?? []) {
      const [name, path] = parse(arg, `--${mode} `)
      given(name)
      call.files[name] = { mode, path }
    }
  }
  return call
}

/** `name=value`, a string, or `name:=json`, any JSON. */
function parse(arg: string, option = ''): [string, Json] {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(:?=)(.*)$/su.exec(arg)
  if (match === null) throw new UsageError(`${option}${arg} is neither ${option}<name>=<value> nor ${option}<name>:=<json>`)
  const [, name, operator, text] = match
  if (operator === '=') return [name, text]
  try {
    return [name, JSON.parse(text) as Json]
  } catch {
    throw new UsageError(`the value of ${name} is not JSON: ${text}`)
  }
}
