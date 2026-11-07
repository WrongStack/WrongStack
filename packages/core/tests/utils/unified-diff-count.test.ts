import { describe, expect, it } from 'vitest';
import { completedToolReceipt } from '../../../coordination/src/agent-status-helpers.js';
import { compactDiff } from '../../src/utils/tool-output-renderers.js';
import { countUnifiedDiffLines } from '../../src/utils/unified-diff-count.js';

const SEPARATOR_PATCH = [
  '--- a/docs/a.md',
  '+++ b/docs/a.md',
  '@@ -1,2 +1,1 @@',
  '----',
  '-title: old',
  '+title: new',
].join('\n');

describe('diff consumers count separator lines', () => {
  it('an agent tool receipt counts a removed --- line', () => {
    const receipt = completedToolReceipt({ name: 'patch', input: { patch: SEPARATOR_PATCH } });
    expect(receipt).toMatchObject({ addedLines: 1, removedLines: 2 });
  });

  it('the compacted diff summary counts it too', () => {
    const big = `${SEPARATOR_PATCH}\n${Array.from({ length: 300 }, (_, i) => ` ctx ${i}`).join('\n')}`;
    expect(compactDiff(big)).toContain('removed=2');
  });
});

describe('countUnifiedDiffLines', () => {
  it('counts content lines that begin with --- or +++ and skips only file headers', () => {
    const diff = [
      'diff --git a/docs/a.md b/docs/a.md',
      '--- a/docs/a.md',
      '+++ b/docs/a.md',
      '@@ -1,4 +1,3 @@',
      '----',
      '-title: old',
      '--- legacy SQL comment',
      '+++count;',
      ' body',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');
    expect(countUnifiedDiffLines(diff)).toEqual({ added: 2, removed: 4 });
  });

  it.each(['\n', '\r\n'])('counts adjacent header-shaped content inside a hunk (%j)', (newline) => {
    const patch = [
      '--- a/comments.txt',
      '+++ b/comments.txt',
      '@@ -1 +1 @@',
      '--- old comment',
      '+++ new comment',
    ].join(newline);
    expect(countUnifiedDiffLines(patch)).toEqual({ added: 1, removed: 1 });
    expect(completedToolReceipt({ name: 'patch', input: { patch } })).toMatchObject({
      addedLines: 1,
      removedLines: 1,
    });
    const big = `${patch}${newline}${Array.from({ length: 300 }, (_, i) => ` ctx ${i}`).join(newline)}`;
    expect(compactDiff(big)).toContain('added=1 removed=1');
  });

  it('skips the next file headers after consuming a hunk without git metadata', () => {
    const patch = [
      '--- a/first.txt',
      '+++ b/first.txt',
      '@@ -1,2 +1,2 @@',
      ' unchanged',
      '--- old comment',
      '+++ new comment',
      '--- a/second.txt',
      '+++ b/second.txt',
      '@@ -0,0 +1 @@',
      '+created',
      '--- a/third.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-deleted',
    ].join('\n');
    expect(countUnifiedDiffLines(patch)).toEqual({ added: 2, removed: 2 });
  });

  it('ignores a format-patch preamble before the first hunk', () => {
    const patch = [
      'Subject: [PATCH] fix',
      '---',
      ' a.ts | 2 +-',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n');
    expect(countUnifiedDiffLines(patch)).toEqual({ added: 1, removed: 1 });
  });

  // A hunk header may omit its line counts (`@@`, or `@@ <context>`). The
  // body length is then UNKNOWN, not zero: the counters start at 0 because
  // nothing was declared, which is not the same as "the declared lines were
  // consumed". Every content line of such a body must still be counted.
  it('counts the body of a hunk header that declares no line counts', () => {
    const patch = ['@@', '-old', '+new', '+more'].join('\n');
    expect(countUnifiedDiffLines(patch)).toEqual({ added: 2, removed: 1 });
  });

  it('counts the body of a hunk header that declares no counts but names a context', () => {
    const patch = ['@@ class Foo', '-old', '+new'].join('\n');
    expect(countUnifiedDiffLines(patch)).toEqual({ added: 1, removed: 1 });
  });

  // The mirror case: a header that DOES declare counts bounds its body, so a
  // line after the declared extent is not content.
  it('stops counting once a hunk header that declares counts is exhausted', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-old', '+new', '-not part of the hunk'].join('\n');
    expect(countUnifiedDiffLines(patch)).toEqual({ added: 1, removed: 1 });
  });

  it('resets hunk state on subsequent diff --git headers so non-hunk lines are ignored (F101)', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/binary.png b/binary.png',
      '-- ',
      '2.45.0',
    ].join('\n');
    expect(countUnifiedDiffLines(patch)).toEqual({ added: 1, removed: 1 });
  });
});

// `files=N` is a count of FILES, and `git diff` names each file twice
// (`diff --git a/x b/x` and `--- a/x`). Counting the two spellings as two
// entries reported 2 files for a 1-file diff and 2N for an N-file diff.
describe('compactDiff counts files, not file headers', () => {
  /** `files=N` out of the emitted summary header. */
  const files = (diff: string): string | undefined =>
    /diff_summary \([^)]*\bfiles=(\d+)/.exec(compactDiff(diff))?.[1];

  /** Padding past DIFF_INLINE_LINE_LIMIT so compactDiff actually compacts. */
  const pad = (): string[] => Array.from({ length: 300 }, (_, i) => ` ctx line ${i}`);

  it('reports one file for a single-file git diff', () => {
    const diff = [
      'diff --git a/src/only.ts b/src/only.ts',
      'index 1111111..2222222 100644',
      '--- a/src/only.ts',
      '+++ b/src/only.ts',
      '@@ -1,3 +1,3 @@',
      '-const before = 1;',
      '+const after = 2;',
      ...pad(),
    ].join('\n');
    expect(files(diff)).toBe('1');
  });

  it('reports one file per file across a multi-file git diff', () => {
    const diff = [
      'diff --git a/src/one.ts b/src/one.ts',
      '--- a/src/one.ts',
      '+++ b/src/one.ts',
      '@@ -1,2 +1,2 @@',
      '-a',
      '+b',
      ...pad(),
      'diff --git a/src/two.ts b/src/two.ts',
      '--- a/src/two.ts',
      '+++ b/src/two.ts',
      '@@ -1,2 +1,2 @@',
      '-c',
      '+d',
    ].join('\n');
    expect(files(diff)).toBe('2');
  });

  // Control: a diff whose only header is the `--- `/`+++ ` pair (no
  // `diff --git` line) was already counted correctly and must stay so.
  it('reports one file for a ---/+++ only diff', () => {
    const diff = [
      '--- src/only.ts',
      '+++ src/only.ts',
      '@@ -1,3 +1,3 @@',
      '-const before = 1;',
      '+const after = 2;',
      ...pad(),
    ].join('\n');
    expect(files(diff)).toBe('1');
  });

  // Boundary: removed content that merely starts with `--- ` (a deleted SQL
  // or Lua `-- comment`) is hunk content, not a file header.
  it('does not count removed "--- comment" content as a file', () => {
    const diff = [
      'diff --git a/src/query.sql b/src/query.sql',
      '--- a/src/query.sql',
      '+++ b/src/query.sql',
      '@@ -1,4 +1,3 @@',
      '--- legacy SQL comment',
      '+SELECT 1;',
      ...pad(),
    ].join('\n');
    expect(files(diff)).toBe('1');
  });

  // `git diff` renders an ADDED file with `--- /dev/null` and a DELETED file
  // with `+++ /dev/null`. `/dev/null` is not a path: keying it registered a
  // second entry beside the real one from `diff --git`, so a one-file add
  // reported files=2.
  it('counts one file for a git diff that adds a file', () => {
    const diff = [
      'diff --git a/added.txt b/added.txt',
      'new file mode 100644',
      'index 0000000..905aa2b',
      '--- /dev/null',
      '+++ b/added.txt',
      '@@ -0,0 +1,300 @@',
      '+first',
      ...pad(),
    ].join('\n');
    expect(files(diff)).toBe('1');
  });

  it('counts one file for a git diff that deletes a file', () => {
    const diff = [
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'index 42a4ab2..0000000',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1,300 +0,0 @@',
      '-first',
      ...pad(),
    ].join('\n');
    expect(files(diff)).toBe('1');
  });

  // Boundary: a bare (no `diff --git`) add diff must still name the real file,
  // not `/dev/null` — the fix falls through to the `+++ ` side, it does not
  // simply drop the pair.
  it('names the added file for a ---/+++ only add diff', () => {
    const diff = ['--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,2 @@', '+a', '+b', ...pad()].join(
      '\n',
    );
    expect(files(diff)).toBe('1');
  });
});
