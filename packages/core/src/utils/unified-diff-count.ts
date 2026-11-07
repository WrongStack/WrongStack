/**
 * Added/removed line counts of a unified diff.
 *
 * Counting `+`/`-` lines while excluding every line that starts with `+++` or
 * `---` drops content: a removed YAML or Markdown `---` separator is the line
 * `----`, a removed `-- SQL comment` is `--- SQL comment`, an added `++i;` is
 * `+++i;`. Only the file header is not content, and it is recognisable as a
 * pair outside a hunk — a `--- ` line directly followed by a `+++ ` line.
 * Hunk line counts distinguish that pair from adjacent content. Lines before the
 * first hunk (commit message, `git format-patch` preamble and its `---`
 * separator) are not counted either.
 *
 * A header that declares its line counts (`@@ -1,2 +1,3 @@`) also BOUNDS the
 * body: once those lines are consumed the hunk is over, so a trailing line
 * (a `git format-patch` signature trailer, a summary footer) is not content.
 * A header that declares NO counts (`@@`, `@@ <context>`) leaves the body
 * length unknown — its counters start at 0, which is not the same as "the
 * body is exhausted" — so its content lines keep counting.
 */
export function countUnifiedDiffLines(diff: string): { added: number; removed: number } {
  const lines = diff.split(/\r?\n/);
  let added = 0;
  let removed = 0;
  let sawHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;
  // Whether the CURRENT hunk header declared its line counts (`@@ -1,2 +1,3 @@`).
  // A header that declares none (`@@`, or `@@ <context>`) leaves the body
  // extent UNKNOWN: its counters stay at 0, which is NOT the same as "the
  // body is over". Only a declared extent can be exhausted, so only then does
  // a following line fall outside the hunk.
  let hunkCountsDeclared = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.startsWith('@@')) {
      sawHunk = true;
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      oldRemaining = hunk ? Number(hunk[1] ?? 1) : 0;
      newRemaining = hunk ? Number(hunk[2] ?? 1) : 0;
      hunkCountsDeclared = hunk !== null;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      sawHunk = false;
      oldRemaining = 0;
      newRemaining = 0;
      hunkCountsDeclared = false;
      continue;
    }
    if (!sawHunk) continue;
    if (
      oldRemaining <= 0 &&
      newRemaining <= 0 &&
      line.startsWith('--- ') &&
      lines[index + 1]?.startsWith('+++ ')
    ) {
      index += 1;
      continue;
    }
    // The body is over only when the header declared its length. A counts-less
    // header leaves the counters at 0 from the start, which is NOT the same as
    // "the declared lines were consumed".
    if (hunkCountsDeclared && oldRemaining <= 0 && newRemaining <= 0) continue;
    if (line.startsWith('+')) {
      added += 1;
      newRemaining -= 1;
    } else if (line.startsWith('-')) {
      removed += 1;
      oldRemaining -= 1;
    } else if (line.startsWith(' ')) {
      oldRemaining -= 1;
      newRemaining -= 1;
    }
  }
  return { added, removed };
}
