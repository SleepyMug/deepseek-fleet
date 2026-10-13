/**
 * @module @sleepymug/fleet-core/util/error
 */

/** What a thrown value says: an error's message, or the value as text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
