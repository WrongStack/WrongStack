export type WordPart = { kind: 'same' | 'add' | 'remove'; text: string };

/** Above this many tokens per side the comparison is skipped instead of stalling the UI. */
export const MAX_DIFF_TOKENS = 3000;
/** Cells of the comparison table for the changed middle (about 4 MB). */
const MAX_TABLE_CELLS = 1_000_000;

/** Words and the whitespace between them, so joining the parts reproduces each text exactly. */
function tokens(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/**
 * Word-level comparison for prose. Joining the `same` and `remove` parts gives `before`, and
 * `same` plus `add` gives `after`. Returns null when either side is too large to compare.
 */
export function wordDiff(before: string, after: string): WordPart[] | null {
  const a = tokens(before),
    b = tokens(after);
  if (a.length > MAX_DIFF_TOKENS || b.length > MAX_DIFF_TOKENS) return null;
  // Common prefix and suffix keep the quadratic table to the changed middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA),
    midB = b.slice(start, endB);
  const rows = midA.length + 1,
    cols = midB.length + 1;
  if (rows * cols > MAX_TABLE_CELLS) return null;
  const table = new Uint32Array(rows * cols);
  for (let i = midA.length - 1; i >= 0; i--)
    for (let j = midB.length - 1; j >= 0; j--)
      table[i * cols + j] =
        midA[i] === midB[j]
          ? table[(i + 1) * cols + j + 1]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
  const parts: WordPart[] = [];
  const push = (kind: WordPart['kind'], text: string) => {
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text;
    else if (text) parts.push({ kind, text });
  };
  push('same', a.slice(0, start).join(''));
  let i = 0,
    j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      push('same', midA[i]!);
      i++;
      j++;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) push('remove', midA[i++]!);
    else push('add', midB[j++]!);
  }
  while (i < midA.length) push('remove', midA[i++]!);
  while (j < midB.length) push('add', midB[j++]!);
  push('same', a.slice(endA).join(''));
  return parts;
}
