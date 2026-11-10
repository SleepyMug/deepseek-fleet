/**
 * @module @sleepymug/dsh-tau/util/error
 */

/** What a thrown value says: an error's message, or the value as text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The code of a failure, such as the fleet host's `BOX_GONE`, or an `FsError`'s, if it has one. */
export function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}
