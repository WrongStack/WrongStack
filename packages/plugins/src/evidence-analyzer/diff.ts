/**
 * Minimal unified-diff reader shared by the diff-aware evidence analyzers.
 *
 * Only what the analyzers need: which file each changed line belongs to, and
 * whether a pasted text is a diff at all. Context lines never count as a
 * change — a risk keyword sitting next to an edit is not a risky edit.
 */
import { isTestPath } from './project.js';

export interface DiffFile {
  /** Path after the change (`+++ b/…`), or the old path for a deletion. */
  path: string;
  added: Array<{ line: number; text: string }>;
  removed: string[];
}

/** Does the text look like `git diff` output? */
export function looksLikeDiff(content: string): boolean {
  return /^(?:diff --git |@@ -\d)/m.test(content) && /^\+\+\+ /m.test(content);
}

function stripPrefix(path: string): string {
  const trimmed = path.trim().replace(/^"(.*)"$/, '$1');
  if (trimmed === '/dev/null') return '';
  return trimmed.replace(/^[ab]\//, '');
}

/** Split a unified diff into per-file added/removed lines. */
export function parseUnifiedDiff(content: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldPath = '';
  let newLine = 0;
  for (const raw of content.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      current = null;
      oldPath = '';
      continue;
    }
    if (line.startsWith('--- ')) {
      oldPath = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      current = { path: stripPrefix(line.slice(4)) || oldPath, added: [], removed: [] };
      files.push(current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+')) {
      current.added.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith('-')) {
      current.removed.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      newLine += 1;
    }
  }
  return files;
}

/**
 * Keep only the changed lines of a pasted diff (same line count, so reported
 * line numbers still point into the paste). Lines of files the predicate
 * rejects are blanked too. A non-diff text is returned unchanged.
 */
export function keepChangedLines(
  content: string,
  includeFile: (path: string) => boolean = () => true,
): string {
  if (!looksLikeDiff(content)) return content;
  let include = true;
  let oldPath = '';
  return content
    .split('\n')
    .map((raw) => {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.startsWith('diff --git ')) {
        include = true;
        return line;
      }
      if (line.startsWith('--- ')) {
        oldPath = stripPrefix(line.slice(4));
        return line;
      }
      if (line.startsWith('+++ ')) {
        include = includeFile(stripPrefix(line.slice(4)) || oldPath);
        return line;
      }
      if (!include) return '';
      return /^[+-]/.test(line) ? line : '';
    })
    .join('\n');
}

/** Blank changed lines of test files: risk words in fixtures are not risk. */
export function keepNonTestChanges(content: string): string {
  return keepChangedLines(content, (path) => !isTestPath(path));
}
