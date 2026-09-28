export function wordFrequencies(text) {
  const counts = {}
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []) counts[word] = (counts[word] ?? 0) + 1
  return counts
}
