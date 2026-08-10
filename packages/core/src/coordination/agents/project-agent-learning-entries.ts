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
 * Split a **legacy** learned.md body into individual entries.
 *
 * Entries are delimited by `---` runs, which is only meaningful for the old
 * append-only journal format. The structured document uses `---` exactly once
 * (before its footer), so this function returns 2 chunks for any structured
 * buffer regardless of how many directives it holds. Callers that need a real
 * entry count must use `parseStructuredLearnedEntries` — this one exists only
 * to migrate pre-structured files.
 */
export function splitLearnedEntries(body: string): string[] {
  return body
    .split(/\n---\n+/)
    .map((entry) => entry.trim())
    .map((entry) =>
      entry
        // Both the legacy ("wisdom") and current ("instructions") headers, the
        // rendered preamble, the empty-state placeholder and the footer are
        // document chrome. Leaving them in made an *empty* structured buffer
        // parse as one bogus directive via the legacy fallback.
        .replace(/^#\s+Learned (?:wisdom|instructions) for .+$/im, '')
        .replace(/^>\s*Project-specific learning data for[\s\S]*?$/im, '')
        .replace(/^_No learned entries yet\._$/im, '')
        .replace(/^\*Last capture:[^\n]*\*$/im, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim(),
    )
    .filter(Boolean);
}
