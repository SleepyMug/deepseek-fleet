/**
 * The `fleet` command's options: leading `--name` or `-n` flags and values,
 * ended by the first other argument or by `--`.
 * @module fleet-client/control/options
 */

/** A command line the command does not accept; it prints its usage. */
export class UsageError extends Error {}

/**
 * Split leading options from the arguments after them. A `value` option
 * takes the next argument whatever it is, or what follows `=`; `--` ends the
 * options, before an argument that starts with `-`.
 */
export function parseOptions(args: readonly string[], kinds: Readonly<Partial<Record<string, 'flag' | 'value'>>>): {
  flags: Set<string>
  values: Map<string, string>
  positional: string[]
} {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  let index = 0
  while (index < args.length) {
    const arg = args[index]!
    if (arg === '--') {
      index++
      break
    }
    if (!arg.startsWith('-') || arg === '-') break
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    const kind = kinds[name]
    if (kind === undefined) throw new UsageError(`unknown option ${name}`)
    if (kind === 'flag') {
      if (equals !== -1) throw new UsageError(`${name} takes no value`)
      flags.add(name)
      index++
      continue
    }
    const value = equals === -1 ? args[index + 1] : arg.slice(equals + 1)
    if (value === undefined || value === '') throw new UsageError(`${name} needs a value`)
    values.set(name, value)
    index += equals === -1 ? 2 : 1
  }
  return { flags, values, positional: args.slice(index) }
}
