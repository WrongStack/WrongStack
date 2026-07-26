/**
 * Return the Jaccard similarity (0-1) of two normalised token sets.
 */
export function tokenOverlap(a: string, b: string): number {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  const intersect = new Set([...setA].filter((t) => setB.has(t)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersect.size / union.size;
}

/**
 * Split an existing learned.md body into individual entries.
 * Entries are delimited by `---\n\n` sequences.
 */
export function splitLearnedEntries(body: string): string[] {
  return body
    .split(/\n---\n+/)
    .map((entry) => entry.trim())
    .map((entry) =>
      entry
        .replace(/^# Learned wisdom for .+$/im, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim(),
    )
    .filter(Boolean);
}
