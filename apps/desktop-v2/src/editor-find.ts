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
  const matches: TextMatch[] = [];
  let from = 0;
  while (matches.length < MAX_MATCHES) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;
    matches.push({ start, end: start + query.length });
    from = start + query.length;
  }
  return matches;
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
    return index < 0 ? 0 : index;
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
