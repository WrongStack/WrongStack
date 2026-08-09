/**
 * Shared helpers for the tree-sitter extractor.
 *
 * Newline-offset binary search is the same pattern `generic-parser.ts` and
 * `import-extractor.ts` use: precompute the offset of every `\n` once per
 * file, then resolve match→line in O(log n) instead of O(n). Tree-sitter
 * gives us `{ row, column }` directly, but we need the same conversion for
 * identifiers that we extract from arbitrary child nodes whose byte offset
 * we have to translate into 1-based line + 0-based col ourselves.
 */

/** 1-based {line, col} for a byte offset, using binary search over newline offsets. */
export function lineColAt(
  offsets: readonly number[],
  index: number,
): { line: number; col: number } {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((offsets[mid] ?? 0) < index) low = mid + 1;
    else high = mid;
  }
  const lastNl = low > 0 ? (offsets[low - 1] ?? -1) : -1;
  return { line: low + 1, col: index - lastNl };
}

/**
 * Precompute newline offsets once per file. The cost is a single O(n) scan
 * of the buffer; subsequent lookups (typically dozens to hundreds per file)
 * are O(log n) instead of O(n).
 */
export function newlineOffsets(content: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) offsets.push(i);
  }
  return offsets;
}

/**
 * Cap the source the visitor walks, mirroring `GENERIC_MAX_FILE_CHARS` in
 * `generic-parser.ts`. Files larger than this get sliced; the rest is dropped
 * from the index. Mirrors the safety net that the regex extractor already
 * applies — without it, a multi-MB blob can blow the AST heap.
 */
export const TREE_SITTER_MAX_FILE_CHARS = 512 * 1024;

/** Soft cap on symbols per file (matches `GENERIC_MAX_SYMBOLS_DEFAULT`). */
export const TREE_SITTER_MAX_SYMBOLS = 500;
