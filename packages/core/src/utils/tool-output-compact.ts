import { countUnifiedDiffLines } from './unified-diff-count.js';

export type RecordValue = Record<string, unknown>;

export const INLINE_LIMIT = 240;

export const DIFF_INLINE_LINE_LIMIT = 260;

export const DIFF_HUNK_LIMIT = 8;

export const DIFF_HUNK_CONTEXT = 14;

/**
 * Distinct FILES in a unified diff.
 *
 * A file boundary is a `diff --git a/<path> b/<path>` line, or a `--- `/`+++ `
 * pair OUTSIDE a hunk body. Two rules the previous per-line regex broke:
 *
 * 1. `git diff` names each file twice — `diff --git a/x b/x` yields `x`, and the
 *    `--- a/x` line yields `a/x`. Both were collected, so every ordinary
 *    single-file diff counted as 2 and every N-file diff as 2N.
 * 2. A hunk-body line that merely starts with `--- ` (a removed SQL/Lua
 *    `-- comment`) is content, not a header.
 *
 * Mirrors the pair-based rule `countUnifiedDiffLines` already applies, so the
 * two counters in the same header cannot disagree about where a file starts.
 * `a/`/`b/` prefixes are stripped so both spellings of one file collapse.
 */
function countDiffFiles(lines: string[]): number {
  // Both spellings of one file must collapse to the same key: `diff --git`
  // yields the bare path (`src/only.ts`) while the `--- ` header yields the
  // prefixed one (`a/src/only.ts`). Strip the prefix rather than emit two keys.
  const key = (path: string): string => path.replace(/^[ab]\//, '');
  const files = new Set<string>();
  // A hunk body ends when its declared line counts are consumed (as in
  // countUnifiedDiffLines): a diff without `diff --git` lines (`diff -ruN`, a
  // hand-written multi-file patch) has its next file header right after it.
  let oldRemaining = 0;
  let newRemaining = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('@@')) {
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      oldRemaining = hunk ? Number(hunk[1] ?? 1) : 0;
      newRemaining = hunk ? Number(hunk[2] ?? 1) : 0;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      oldRemaining = 0;
      newRemaining = 0;
      const match = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/.exec(line);
      if (match) files.add(key(match[1]!));
      continue;
    }
    const inHunk = oldRemaining > 0 || newRemaining > 0;
    if (inHunk) {
      if (line.startsWith('+')) newRemaining -= 1;
      else if (line.startsWith('-')) oldRemaining -= 1;
      else if (line.startsWith(' ')) {
        oldRemaining -= 1;
        newRemaining -= 1;
      }
    }
    // Only a pair OUTSIDE a hunk is a header; inside one it is content.
    if (!inHunk && line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const from = line.slice(4);
      const to = (lines[i + 1] ?? '').slice(4);
      // `/dev/null` is git's marker for the absent side of an add
      // (`--- /dev/null`) or a delete (`+++ /dev/null`); it is not a file.
      // Keying it registered a second entry beside the real path from
      // `diff --git`, so a one-file add reported files=2.
      const path = from === '/dev/null' ? to : from;
      if (path !== '/dev/null') files.add(key(path));
      i += 1;
    }
  }
  return files.size;
}

export function compactDiff(diff: string): string {
  const lines = diff.split(/\r?\n/);
  if (lines.length <= DIFF_INLINE_LINE_LIMIT) return diff;

  const fileCount = countDiffFiles(lines);
  const hunks = lines.filter((line) => line.startsWith('@@')).length;
  const { added, removed } = countUnifiedDiffLines(diff);

  // Collect [start, end] intervals as we scan lines sequentially.
  // Intervals are naturally ordered by line index — no sort needed.
  const intervals: Array<[number, number]> = [];
  let hunkCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      intervals.push([i, i]);
      continue;
    }
    if (!line.startsWith('@@')) continue;
    if (hunkCount >= DIFF_HUNK_LIMIT) continue;
    hunkCount++;
    intervals.push([i, Math.min(lines.length - 1, i + DIFF_HUNK_CONTEXT)]);
  }

  if (intervals.length === 0) {
    return joinSections([
      renderHeader('diff_summary', {
        files: fileCount,
        hunks,
        added,
        removed,
        lines: lines.length,
      }),
      lines.slice(0, DIFF_INLINE_LINE_LIMIT).join('\n'),
      `[serializer omitted ${Math.max(0, lines.length - DIFF_INLINE_LINE_LIMIT)} diff line(s)]`,
    ]);
  }

  // Merge overlapping / adjacent intervals in a single O(n) pass.
  // Intervals are already in ascending order from the sequential scan.
  const merged: Array<[number, number]> = [intervals[0]!];
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1]!;
    const current = intervals[i]!;
    if (current[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], current[1]);
    } else {
      merged.push(current);
    }
  }

  // Build excerpt from merged intervals — O(n), no sort.
  const excerpt: string[] = [];
  let prevLine = -1;
  for (const [start, end] of merged) {
    if (start > prevLine + 1) {
      const omitted = prevLine === -1 ? start : start - prevLine - 1;
      excerpt.push(`[serializer omitted ${omitted} diff line(s)]`);
    }
    for (let j = start; j <= end; j++) {
      excerpt.push(lines[j] ?? '');
    }
    prevLine = end;
  }

  const trailing = lines.length - prevLine - 1;
  if (trailing > 0) excerpt.push(`[serializer omitted ${trailing} trailing diff line(s)]`);

  return joinSections([
    renderHeader('diff_summary', {
      files: fileCount,
      hunks,
      shown_hunks: Math.min(hunks, DIFF_HUNK_LIMIT),
      added,
      removed,
      lines: lines.length,
    }),
    excerpt.join('\n'),
  ]);
}

export function compactFailureOutput(output: string): string {
  const lines = output.split(/\r?\n/);
  if (lines.length <= 260) return output.trimEnd();

  const selected = new Set<number>();
  const marker =
    /\b(fail|failed|failure|error|exception|assertionerror|expected|received|actual|timeout|stack)\b/i;
  let markerHits = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!marker.test(lines[i] ?? '')) continue;
    markerHits++;
    for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 10); j++) {
      selected.add(j);
    }
  }

  if (markerHits === 0) {
    return lines.slice(-220).join('\n').trimEnd();
  }

  const ordered = [...selected].sort((a, b) => a - b);
  const out: string[] = [];
  let previous = -1;
  for (const index of ordered) {
    if (index > previous + 1) {
      const omitted = previous === -1 ? index : index - previous - 1;
      out.push(`[serializer omitted ${omitted} line(s)]`);
    }
    out.push(lines[index] ?? '');
    previous = index;
  }
  return out.join('\n').trimEnd();
}

export function renderHeader(label: string, fields: RecordValue): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${clipInline(formatInlineValue(value))}`);
  return parts.length > 0 ? `${label} (${parts.join(' ')})` : label;
}

export function joinSections(sections: Array<string | undefined>): string {
  return sections
    .map((section) => (typeof section === 'string' ? section.trimEnd() : undefined))
    .filter((section): section is string => !!section)
    .join('\n');
}

export function formatInlineValue(value: unknown): string {
  /* v8 ignore next -- no renderHeader field is ever an array (all callers pass scalars) */
  if (Array.isArray(value)) return `[${value.map(formatInlineValue).join(',')}]`;
  if (isScalar(value)) return String(value);
  return oneLineJson(value);
}

export function clipInline(value: string, max = INLINE_LIMIT): string {
  const limit = Number.isFinite(max) ? Math.floor(max) : 0;
  if (limit <= 0) return '';
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= limit) return compact;
  // Never cut a surrogate pair: a lone half is invalid text in the rendered header.
  let end = Math.max(0, limit - 15);
  if (end > 0 && /[\uD800-\uDBFF]/.test(compact[end - 1]!)) end--;
  return `${compact.slice(0, end)}...(${compact.length} chars)`;
}

export function oneLineJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}
