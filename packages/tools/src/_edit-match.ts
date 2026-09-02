/**
 * Matching ladder for the `edit` tool.
 *
 * Models routinely hallucinate whitespace when reproducing code they read
 * many turns ago: trailing spaces appear, indentation shifts by a level,
 * tabs become spaces. A strict exact-match `old_string` fails on all of
 * these even though the intended target is unambiguous. This module
 * implements a graded fallback chain — each tier is strictly more permissive
 * and strictly lower-confidence than the previous one:
 *
 *   1. `exact`                  — substring match (the classic behavior).
 *   2. `trailing-whitespace`    — whole-line window match ignoring trailing
 *                                 whitespace per line. Zero ambiguity risk
 *                                 beyond exact (trailing blanks never carry
 *                                 meaning in the languages we edit).
 *   3. `whitespace-normalized`  — whole-line window match ignoring leading
 *                                 AND trailing whitespace per line. The
 *                                 replacement is re-indented to the file's
 *                                 actual indentation.
 *   4. `fuzzy`                  — block-anchor match: first and last lines
 *                                 must match (trimmed), interior lines are
 *                                 compared by Levenshtein similarity. Only a
 *                                 single candidate with a clear margin over
 *                                 the runner-up is accepted.
 *
 * The caller (edit.ts) enforces per-tier uniqueness, restricts `replace_all`
 * to tiers 1–2, and surfaces the tier + confidence in the tool output so the
 * model and the session log both see when a fallback fired.
 */

export type MatchTier = 'exact' | 'trailing-whitespace' | 'whitespace-normalized' | 'fuzzy';

interface LadderMatch {
  /** Char offset (inclusive) of the match start in the LF-normalized file. */
  start: number;
  /** Char offset (exclusive) of the match end. */
  end: number;
  /** 1-based line number of the first matched line (for error messages). */
  startLine: number;
}

interface LadderResult {
  tier: MatchTier;
  matches: LadderMatch[];
  /** Similarity score of the best candidate — only set for the fuzzy tier. */
  score?: number | undefined;
  /**
   * Fuzzy tier only: true when two candidates scored within the ambiguity
   * margin of each other, so no single target can be trusted. `matches`
   * then contains the rival candidates for the error message.
   */
  ambiguous?: boolean | undefined;
}

/** Human-readable label per tier, used in notes and error messages. */
export const TIER_LABEL: Record<MatchTier, string> = {
  exact: 'exact match',
  'trailing-whitespace': 'whitespace-normalized match (trailing whitespace ignored)',
  'whitespace-normalized':
    'whitespace-normalized match (indentation ignored, replacement re-indented)',
  fuzzy: 'fuzzy match (block anchors exact, interior ≥90% similar)',
};

/** Confidence per tier, recorded in the tool output note. */
export const TIER_CONFIDENCE: Record<MatchTier, 'exact' | 'high' | 'medium' | 'low'> = {
  exact: 'exact',
  'trailing-whitespace': 'high',
  'whitespace-normalized': 'medium',
  fuzzy: 'low',
};

/** Below this many non-whitespace chars, indent-insensitive tiers are too
 *  ambiguous to trust (`}` would match everywhere). */
const MIN_NORMALIZED_NEEDLE_CHARS = 16;
/** Fuzzy interior similarity threshold. */
const FUZZY_MIN_SIMILARITY = 0.9;
/** A fuzzy best-candidate must beat the runner-up by at least this margin. */
const FUZZY_AMBIGUITY_MARGIN = 0.05;
/** Cost guard: skip fuzzy comparison on interiors larger than this. */
const FUZZY_MAX_INTERIOR_CHARS = 2000;

/**
 * Walk the ladder and return the first tier that produces at least one
 * match. Returns `undefined` when no tier matches.
 */
export function findLadderMatches(fileLf: string, oldLf: string): LadderResult | undefined {
  // Tier 1 — exact substring scan (supports sub-line needles).
  const exact: LadderMatch[] = [];
  let idx = fileLf.indexOf(oldLf);
  let currentLine = 1;
  let lastPos = 0;
  while (idx !== -1) {
    while (lastPos < idx) {
      const nextNewline = fileLf.indexOf('\n', lastPos);
      if (nextNewline === -1 || nextNewline >= idx) break;
      currentLine++;
      lastPos = nextNewline + 1;
    }
    exact.push({ start: idx, end: idx + oldLf.length, startLine: currentLine });
    idx = fileLf.indexOf(oldLf, idx + 1);
  }
  if (exact.length > 0) return { tier: 'exact', matches: exact };

  // Line-based tiers operate on whole-line windows.
  const fileLines = fileLf.split('\n');
  const needleEndsWithNewline = oldLf.endsWith('\n');
  const rawNeedleLines = oldLf.split('\n');
  const needleLines =
    needleEndsWithNewline && rawNeedleLines[rawNeedleLines.length - 1] === ''
      ? rawNeedleLines.slice(0, -1)
      : rawNeedleLines;
  if (needleLines.length === 0 || needleLines.length > fileLines.length) return undefined;
  const offsets = lineOffsets(fileLines);

  // Pre-trim file lines ONCE so the sliding window doesn't call trimEnd()/
  // trim() on every (fileLine × needleLine) pair — avoiding O(n·m) string
  // allocations for every tier. For a 10 000-line × 10-line needle that
  // saves ~200 000 trim() calls per tier.
  const fileTrimEnd = fileLines.map((l) => l.trimEnd());
  const needleTrimEnd = needleLines.map((l) => l.trimEnd());

  const trailing = windowScan(
    fileTrimEnd,
    needleTrimEnd,
    offsets,
    fileLines,
    (a, b) => a === b,
    needleEndsWithNewline,
  );
  if (trailing.length > 0) return { tier: 'trailing-whitespace', matches: trailing };

  const normalizedLen = needleTrimEnd.reduce((n, l) => n + l.trimStart().length, 0);
  if (normalizedLen < MIN_NORMALIZED_NEEDLE_CHARS) return undefined;

  const fileTrimmed = fileTrimEnd.map((l) => l.trimStart());
  const needleTrimmed = needleTrimEnd.map((l) => l.trimStart());
  const normalized = windowScan(
    fileTrimmed,
    needleTrimmed,
    offsets,
    fileLines,
    (a, b) => a === b,
    needleEndsWithNewline,
  );
  if (normalized.length > 0) return { tier: 'whitespace-normalized', matches: normalized };

  return fuzzyScan(fileLines, needleLines, offsets, needleEndsWithNewline);
}

/** Start char offset of each line in the LF-normalized text. */
function lineOffsets(lines: string[]): number[] {
  const out = new Array<number>(lines.length);
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    out[i] = pos;
    pos += (lines[i] as string).length + 1; // +1 for the '\n'
  }
  return out;
}

function windowToMatch(
  fileLines: string[],
  offsets: number[],
  start: number,
  windowLen: number,
  includeTrailingNewline = false,
): LadderMatch {
  const lastLine = start + windowLen - 1;
  const lineEnd = (offsets[lastLine] as number) + (fileLines[lastLine] as string).length;
  const end = includeTrailingNewline && lastLine < fileLines.length - 1 ? lineEnd + 1 : lineEnd;
  return {
    start: offsets[start] as number,
    end,
    startLine: start + 1,
  };
}

/** Slide a needle-sized window over the file lines with a per-line comparator.
 *  Matched windows never overlap (scan resumes after the window). */
function windowScan(
  comparisonLines: string[],
  needleLines: string[],
  offsets: number[],
  originalLines: string[],
  eq: (fileLine: string, needleLine: string) => boolean,
  includeTrailingNewline = false,
): LadderMatch[] {
  const n = needleLines.length;
  const out: LadderMatch[] = [];
  for (let i = 0; i + n <= comparisonLines.length; i++) {
    let all = true;
    for (let j = 0; j < n; j++) {
      if (!eq(comparisonLines[i + j] as string, needleLines[j] as string)) {
        all = false;
        break;
      }
    }
    if (all) {
      out.push(windowToMatch(originalLines, offsets, i, n, includeTrailingNewline));
      i += n - 1; // no overlapping windows
    }
  }
  return out;
}

/** Block-anchor fuzzy tier: first/last lines trim-exact, interior by
 *  Levenshtein similarity. Requires ≥3 needle lines so anchors exist. */
function fuzzyScan(
  fileLines: string[],
  needleLines: string[],
  offsets: number[],
  includeTrailingNewline = false,
): LadderResult | undefined {
  const n = needleLines.length;
  if (n < 3) return undefined;
  const firstNeedle = (needleLines[0] as string).trim();
  const lastNeedle = (needleLines[n - 1] as string).trim();
  const needleInterior = needleLines
    .slice(1, -1)
    .map((l) => l.trim())
    .join('\n');
  if (needleInterior.length > FUZZY_MAX_INTERIOR_CHARS) return undefined;

  const fileTrimmed = fileLines.map((l) => l.trim());
  const candidates: Array<{ match: LadderMatch; score: number }> = [];
  for (let i = 0; i + n <= fileLines.length; i++) {
    if ((fileTrimmed[i] as string) !== firstNeedle) continue;
    if ((fileTrimmed[i + n - 1] as string) !== lastNeedle) continue;
    const windowInterior = fileTrimmed.slice(i + 1, i + n - 1).join('\n');
    if (windowInterior.length > FUZZY_MAX_INTERIOR_CHARS) continue;
    const score = similarity(needleInterior, windowInterior);
    if (score >= FUZZY_MIN_SIMILARITY) {
      candidates.push({
        match: windowToMatch(fileLines, offsets, i, n, includeTrailingNewline),
        score,
      });
    }
  }

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] as { match: LadderMatch; score: number };
  const runnerUp = candidates[1];
  if (runnerUp && best.score - runnerUp.score < FUZZY_AMBIGUITY_MARGIN) {
    return {
      tier: 'fuzzy',
      matches: candidates.map((c) => c.match),
      score: best.score,
      ambiguous: true,
    };
  }
  return { tier: 'fuzzy', matches: [best.match], score: best.score };
}

/** Normalized similarity in [0, 1]: 1 − levenshtein / max-length. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  const lenDiff = Math.abs(a.length - b.length);
  // Quick reject: Levenshtein distance is bounded below by |a.length - b.length|.
  // If the length difference alone forces similarity below the threshold,
  // skip the expensive O(n·m) DP entirely.
  if (lenDiff / max > 1 - FUZZY_MIN_SIMILARITY) {
    return 1 - lenDiff / max;
  }
  return 1 - levenshtein(a, b) / max;
}

/** Two-row Levenshtein distance with dimension swap and Int32Array. */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (a.length < b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }
  const bLen = b.length;
  const aLen = a.length;
  let prev = new Int32Array(bLen + 1);
  let cur = new Int32Array(bLen + 1);
  for (let j = 0; j <= bLen; j++) prev[j] = j;

  for (let i = 1; i <= aLen; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= bLen; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[bLen] as number;
}

/** Leading whitespace (spaces/tabs) of the first non-empty line, or ''. */
export function firstLineIndent(text: string): string {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    return (/^[ \t]*/.exec(line) as RegExpExecArray)[0];
  }
  return '';
}

/**
 * Shift `newLf` from the needle's indentation to the matched block's actual
 * indentation. Only clean prefix relationships are adjusted (purely adding
 * or removing leading whitespace); a tabs-vs-spaces mismatch is left alone
 * rather than guessed at — the diff in the tool output makes the result
 * visible either way.
 */
export function adjustIndent(
  newLf: string,
  fromIndent: string,
  toIndent: string,
): { text: string; adjusted: boolean } {
  if (fromIndent === toIndent) return { text: newLf, adjusted: false };
  const lines = newLf.split('\n');
  if (toIndent.startsWith(fromIndent)) {
    const extra = toIndent.slice(fromIndent.length);
    return {
      text: lines.map((l) => (l.trim() === '' ? '' : extra + l)).join('\n'),
      adjusted: true,
    };
  }
  if (fromIndent.startsWith(toIndent)) {
    const remove = fromIndent.slice(toIndent.length);
    return {
      text: lines
        .map((l) => {
          if (l.trim() === '') return '';
          return l.startsWith(remove) ? l.slice(remove.length) : l;
        })
        .join('\n'),
      adjusted: true,
    };
  }
  return { text: newLf, adjusted: false };
}

/**
 * Best-effort locator for the no-match error: find the window whose trimmed
 * lines are most similar to the needle. Returns the 1-based line
 * and a short snippet the model can use to correct itself without re-reading.
 */
export function nearestMatchHint(
  fileLf: string,
  oldLf: string,
): { line: number; snippet: string } | undefined {
  const fileLines = fileLf.split('\n');
  const rawNeedle = oldLf.split('\n');
  const needleLines =
    oldLf.endsWith('\n') && rawNeedle[rawNeedle.length - 1] === ''
      ? rawNeedle.slice(0, -1)
      : rawNeedle;
  const n = needleLines.length;
  if (n === 0 || n > fileLines.length) return undefined;

  const needleTrimmed = needleLines.map((l) => l.trim());
  const fileTrimmed = fileLines.map((l) => l.trim());
  let bestScore = 0;
  let bestStart = -1;
  const maxI = fileLines.length - n;

  for (let i = 0; i <= maxI; i++) {
    let sum = 0;
    let possible = true;
    for (let j = 0; j < n; j++) {
      sum += lineSimilarity(needleTrimmed[j] as string, fileTrimmed[i + j] as string);
      // Prune if remaining maximum score cannot beat bestScore
      if (sum + (n - 1 - j) <= bestScore * n) {
        possible = false;
        break;
      }
    }
    if (possible) {
      const score = sum / n;
      if (score > bestScore) {
        bestScore = score;
        bestStart = i;
      }
    }
  }
  if (bestStart === -1 || bestScore < 0.5) return undefined;

  const snippet = fileLines
    .slice(bestStart, bestStart + Math.min(3, n))
    .map((l) => (l.length > 120 ? `${l.slice(0, 120)}…` : l))
    .join('\n');
  return { line: bestStart + 1, snippet };
}

/** Similarity proxy: combination of containment, shared prefix and shared suffix. */
function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  if (a.includes(b) || b.includes(a)) {
    return Math.min(a.length, b.length) / max;
  }
  let p = 0;
  const lim = Math.min(a.length, b.length);
  while (p < lim && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < lim - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return (p + s) / max;
}
