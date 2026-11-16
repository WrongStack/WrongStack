export interface TextMatch {
  start: number;
  end: number;
}

/** Above this many matches the list is cut so a one-letter query cannot stall typing. */
export const MAX_MATCHES = 10_000;

/** Literal, non-overlapping matches of `query` in `text`. */
export function findMatches(text: string, query: string, caseSensitive: boolean): TextMatch[] {
  if (!query) return [];
  const haystack = caseSensitive ? text : text.toLowerCase(),
    needle = caseSensitive ? query : query.toLowerCase();
  // Lowering can change string length (U+0130 İ → i + combining dot), so lowered
  // indices then stop addressing the original `text` that consumers highlight and
  // replace. Map them back for that case; length-preserving lowering (the common
  // case) keeps the fast path. Divergent unit counts (no known lowering does
  // this) fall back to case-sensitive matching, whose indices are always valid.
  const origins =
    caseSensitive || haystack.length === text.length
      ? undefined
      : loweredOrigins(text, haystack.length);
  if (origins === null) return findMatches(text, query, true);
  const matches: TextMatch[] = [];
  let from = 0;
  while (matches.length < MAX_MATCHES) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;
    matches.push(
      origins
        ? {
            start: origins.starts[start]!,
            end: origins.ends[start + needle.length - 1]!,
          }
        : { start, end: start + needle.length },
    );
    from = start + needle.length;
  }
  return matches;
}

/**
 * Lowered-unit → original-text index map for a length-changing lowercase:
 * `starts[i]` is the original index of the character that produced lowered unit
 * `i`, `ends[i]` the index just after it. Per-character lowering yields the same
 * unit counts as whole-string lowering (İ is the only lengthening mapping and is
 * context-free), so the arrays always cover every lowered index; `null` reports
 * the impossible divergence so the caller can degrade instead of misindexing.
 */
function loweredOrigins(
  text: string,
  loweredLength: number,
): { starts: number[]; ends: number[] } | null {
  const starts: number[] = [];
  const ends: number[] = [];
  let read = 0;
  while (read < text.length) {
    const char = String.fromCodePoint(text.codePointAt(read)!);
    const loweredChar = char.toLowerCase();
    for (let unit = 0; unit < loweredChar.length; unit++) {
      starts.push(read);
      ends.push(read + char.length);
      if (starts.length > loweredLength) return null;
    }
    read += char.length;
  }
  return starts.length === loweredLength ? { starts, ends } : null;
}

/**
 * Index of the match to select next from the caret: the first one starting at or after it
 * (forward) or the last one ending before it (backward), wrapping at either end.
 */
export function nextMatchIndex(
  matches: readonly TextMatch[],
  caret: number,
  direction: 1 | -1,
): number {
  if (!matches.length) return -1;
  if (direction === 1) {
    const index = matches.findIndex((match) => match.start >= caret);
    return Math.max(index, 0);
  }
  for (let index = matches.length - 1; index >= 0; index--)
    if (matches[index]!.end <= caret) return index;
  return matches.length - 1;
}

/** Replace every literal match; `count` is how many were replaced. */
export function replaceAllMatches(
  text: string,
  query: string,
  replacement: string,
  caseSensitive: boolean,
): { text: string; count: number } {
  const matches = findMatches(text, query, caseSensitive);
  if (!matches.length || matches.length >= MAX_MATCHES) return { text, count: 0 };
  let result = '',
    cursor = 0;
  for (const match of matches) {
    result += text.slice(cursor, match.start) + replacement;
    cursor = match.end;
  }
  return { text: result + text.slice(cursor), count: matches.length };
}

/** 1-based line of each match start, in order, one entry per matching line. */
export function matchLines(text: string, matches: readonly TextMatch[]): number[] {
  const lines: number[] = [];
  let line = 1,
    cursor = 0;
  for (const match of matches) {
    for (; cursor < match.start; cursor++) if (text.charCodeAt(cursor) === 10) line++;
    if (lines[lines.length - 1] !== line) lines.push(line);
  }
  return lines;
}
