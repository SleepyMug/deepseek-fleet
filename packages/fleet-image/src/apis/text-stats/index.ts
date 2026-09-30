/**
 * Statistics of text, computed in the program itself.
 *
 * @packageDocumentation
 */

/** How often each word occurs in `text`, words lowercased. */
export function wordFrequencies(text: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []) counts[word] = (counts[word] ?? 0) + 1
  return counts
}
