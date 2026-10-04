/**
 * A run's values from the command line: `name=value` gives a text, or, for a
 * parameter whose type is a file, a dir or a path, a handle of the mode the
 * type declares, to the path `value`; `name:=json` gives any value as JSON,
 * as tau's docs/spec/values.md has them. The tau service checks the values
 * against the tau, so a name the tau does not declare passes as a text, for
 * the service to refuse.
 * @module fleet-client/values
 */

import type { Type } from '@sleepymug/tau'

/** A mistake in the command line, answered with a pointer to the usage. */
export class UsageError extends Error {}

/**
 * @param args - the `name=value` and `name:=json` arguments.
 * @param params - the tau's parameters, as tau.json declares them.
 * @returns the values, by parameter.
 */
export function parseValues(args: readonly string[], params: { readonly [name: string]: Type }): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const arg of args) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(:?=)(.*)$/su.exec(arg)
    if (match === null) throw new UsageError(`${arg} is neither <name>=<value> nor <name>:=<json>`)
    const [, name, operator, text] = match
    if (Object.hasOwn(values, name)) throw new UsageError(`${name} is given twice`)
    if (operator === ':=') {
      try {
        values[name] = JSON.parse(text)
      } catch {
        throw new UsageError(`the value of ${name} is not JSON: ${text}`)
      }
      continue
    }
    const type = Object.hasOwn(params, name) ? params[name] : undefined
    values[name] = type !== undefined && 'mode' in type ? { [`$${type.mode}`]: text } : text
  }
  return values
}
