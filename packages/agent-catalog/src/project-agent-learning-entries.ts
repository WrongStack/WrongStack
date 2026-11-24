/**
 * Jaccard similarity of two lexical token sets.
 *
 * This deliberately ignores order: conflict detection uses it to surface
 * reworded or reordered claims that may contradict one another across roles.
 * Deduplication uses {@link directiveSimilarity} instead.
 */
export function tokenOverlap(a: string, b: string): number {
  const setA = new Set(a.split(/\s+/).filter(Boolean));
  const setB = new Set(b.split(/\s+/).filter(Boolean));
  const intersect = new Set([...setA].filter((t) => setB.has(t)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersect.size / union.size;
}

/** Similarity for deciding whether two directives are the same instruction. */
export function directiveSimilarity(a: string, b: string): number {
  const tokensA = a.split(/\s+/).filter(Boolean);
  const tokensB = b.split(/\s+/).filter(Boolean);
  const lexical = tokenOverlap(a, b);
  if (tokensA.length < 2 || tokensB.length < 2) return lexical;

  const bigrams = (tokens: readonly string[]): Set<string> =>
    new Set(tokens.slice(0, -1).map((token, index) => `${token}\0${tokens[index + 1]}`));
  const setA = bigrams(tokensA);
  const setB = bigrams(tokensB);
  const intersect = new Set([...setA].filter((pair) => setB.has(pair)));
  const union = new Set([...setA, ...setB]);
  const ordered = union.size === 0 ? 0 : intersect.size / union.size;

  // Both vocabulary and local order must agree. Taking the weaker score keeps
  // genuine rewords while ensuring a token-set anagram is not an identity.
  return Math.min(lexical, ordered);
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
