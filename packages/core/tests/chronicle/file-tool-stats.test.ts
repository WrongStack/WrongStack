import { describe, expect, it } from 'vitest';
import { fileToolStats } from '../../src/chronicle/file-tool-stats.js';

describe('file tool numeric evidence', () => {
  it('counts numbered source lines rather than summary lines or file size', () => {
    expect(
      fileToolStats('read', JSON.stringify({ text: '20→hello\n21→world', total_lines: 100 })),
    ).toEqual({ readLines: 2, totalLines: 100 });
    expect(
      fileToolStats('read', JSON.stringify({ text: 'already shown', total_lines: 100 })),
    ).toBeUndefined();
    expect(fileToolStats('read', 'truncated JSON')).toBeUndefined();
  });
  it('counts right-aligned read line numbers across digit-width boundaries', () => {
    // `read` pads the line number to the width of the last line in the slice
    // (packages/tools/src/read.ts), so a 1-100 read emits "  1→" … "100→".
    const padded = (offset: number, count: number) => {
      const width = String(offset + count - 1).length;
      return Array.from({ length: count }, (_, i) => {
        const num = String(offset + i);
        return `${' '.repeat(Math.max(0, width - num.length))}${num}→line ${offset + i}`;
      }).join('\n');
    };
    expect(
      fileToolStats('read', JSON.stringify({ text: padded(1, 100), total_lines: 100 })),
    ).toEqual({
      readLines: 100,
      totalLines: 100,
    });
    // Straddles 99→100: the leading nine lines are padded one space wider.
    expect(
      fileToolStats('read', JSON.stringify({ text: padded(95, 10), total_lines: 200 })),
    ).toEqual({ readLines: 10, totalLines: 200 });
    // A padded read still counts; whitespace alone never does.
    expect(
      fileToolStats('read', JSON.stringify({ text: `${padded(1, 9)}\nno numbers here` })),
    ).toEqual({ readLines: 9 });
    expect(fileToolStats('read', JSON.stringify({ text: '   \n  ' }))).toBeUndefined();
  });
  it('derives patch line deltas from the input diff, per file', () => {
    // `patch` output carries no diff at all — the counts come from input.patch.
    const output = JSON.stringify({ applied: 2, rejected: 0, files: ['a.ts', 'b.ts'] });
    const input = {
      patch: [
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,3 +1,4 @@',
        ' keep',
        '-gone',
        '+fresh',
        '+more',
        ' tail',
        '--- a/src/b.ts',
        '+++ b/src/b.ts',
        '@@ -1,2 +1,2 @@',
        ' same',
        '-old',
        '+new',
      ].join('\n'),
      strip: 1,
    };
    expect(fileToolStats('patch', output, input)).toEqual({
      addedLines: 3,
      removedLines: 2,
      partial: false,
      patchFiles: [
        { path: 'src/a.ts', addedLines: 2, removedLines: 1 },
        { path: 'src/b.ts', addedLines: 1, removedLines: 1 },
      ],
    });
  });
  it('does not read hunk body lines as file headers, and honours deletions', () => {
    // `--- SQL comment` / `+++ value` inside a hunk are content, not a new
    // file — they must not reset the running file's counters.
    const output = JSON.stringify({ applied: 1, rejected: 0, files: ['a.ts'] });
    const input = {
      patch: [
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,3 +1,3 @@',
        '--- SQL comment',
        '+++ value',
        ' same',
      ].join('\n'),
    };
    expect(fileToolStats('patch', output, input)).toMatchObject({
      addedLines: 1,
      removedLines: 1,
      patchFiles: [{ path: 'a.ts', addedLines: 1, removedLines: 1 }],
    });
    // A deletion is `+++ /dev/null`; the target is the `---` side.
    const deleted = JSON.stringify({ applied: 1, rejected: 0, files: ['gone.ts'] });
    expect(
      fileToolStats('patch', deleted, {
        patch: ['--- a/gone.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-bye'].join('\n'),
      }),
    ).toMatchObject({ addedLines: 0, removedLines: 1, patchFiles: [{ path: 'gone.ts' }] });
  });
  it('reports no patch evidence for dry runs, empty applies, or a missing input', () => {
    const patch = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+new'].join('\n');
    // A dry run wrote nothing; counting it would invent file activity.
    expect(
      fileToolStats('patch', JSON.stringify({ applied: 1, dry_run: true }), { patch }),
    ).toBeUndefined();
    expect(fileToolStats('patch', JSON.stringify({ applied: 0 }), { patch })).toBeUndefined();
    expect(fileToolStats('patch', JSON.stringify({ applied: 1 }))).toBeUndefined();
    // Input arrives as a JSON string from the chronicle's input preview.
    expect(
      fileToolStats('patch', JSON.stringify({ applied: 1 }), JSON.stringify({ patch })),
    ).toMatchObject({ addedLines: 1 });
  });
  it('credits nothing when a patch reports rejected hunks', () => {
    const patch = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+new'].join('\n');
    // Some hunks did not land and a unified diff carries no per-hunk reject
    // markers, so which file's deltas applied is unknowable. `rejected` is
    // currently only reachable on a dry run — a real failed apply throws — so
    // this pins the guarantee locally rather than trusting that to hold.
    expect(
      fileToolStats('patch', JSON.stringify({ applied: 1, rejected: 1, files: ['a.ts'] }), {
        patch,
      }),
    ).toBeUndefined();
    expect(
      fileToolStats('patch', JSON.stringify({ applied: 3, rejected: 2, files: ['a.ts'] }), {
        patch,
      }),
    ).toBeUndefined();
    // rejected: 0 is the normal fully-applied case and must still count.
    expect(
      fileToolStats('patch', JSON.stringify({ applied: 1, rejected: 0, files: ['a.ts'] }), {
        patch,
      }),
    ).toMatchObject({ addedLines: 1, removedLines: 0 });
  });
  it('marks a patch partial when the body was cut off mid-hunk', () => {
    const output = JSON.stringify({ applied: 1, rejected: 0, files: ['a.ts'] });
    // The subagent bridge bounds the diff body; a hunk still open at EOF means
    // the totals undercount, and `partial` is what tells the UI to say so.
    const cut = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,5 +1,5 @@', ' keep', '+new'].join('\n');
    expect(fileToolStats('patch', output, { patch: cut })).toMatchObject({
      partial: true,
      addedLines: 1,
    });
    // A diff that ends on a hunk boundary is complete, not partial: one
    // context line (both sides) plus one addition (new side only).
    const whole = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+new'].join('\n');
    expect(fileToolStats('patch', output, { patch: whole })).toMatchObject({
      partial: false,
      addedLines: 1,
    });
  });
  it('counts diff hunks, including source lines resembling diff headers', () => {
    expect(
      fileToolStats(
        'edit',
        JSON.stringify({
          diff: '--- a\n+++ b\n@@ -1,2 +1,2 @@\n--- content\n+++ content\n same',
          note: 'Diff truncated to budget',
        }),
      ),
    ).toEqual({ addedLines: 1, removedLines: 1, partial: true });
  });
  it('recognizes the canonical new-file write summary', () => {
    expect(
      fileToolStats(
        'write',
        JSON.stringify({ created: true, diff: '+++ src/a.ts\n+ (new file, 12 lines)' }),
      ),
    ).toEqual({ addedLines: 12, removedLines: 0, partial: false });
  });
  it('parses the serialized formats the event bus actually emits (not JSON)', () => {
    // Regression: production `tool.executed` outputs are rendered text
    // (`read: <path> (…)\n  1→…`, `edit (path=… …)` + diff), and the old
    // JSON.parse-first parser returned undefined for every one of them —
    // which is why Session Story showed no line evidence at all.
    expect(
      fileToolStats(
        'read',
        'read: src/a.ts (limit=80 total_lines=231 encoding=utf8 truncated=true)\n 1→const a = 1;\n 2→const b = 2;\n 3→const c = 3;',
      ),
    ).toEqual({ readLines: 3, totalLines: 231, partial: false });
    // The event envelope caps output at ~400 chars (truncateForEvent) and
    // marks the cut with a trailing ellipsis — the surviving numbered lines
    // are a prefix count and must be flagged partial, never exact.
    const truncatedStats = fileToolStats(
      'read',
      'read: src/a.ts (limit=50 total_lines=300 encoding=utf8 truncated=false)\n 1→import x;\n 2→import y;\n 3→import z;\n 4→…',
    );
    expect(truncatedStats).toMatchObject({ readLines: 4, partial: true });
    // Summary/binary/stub reads carry no numbered lines.
    expect(
      fileToolStats('read', 'read: src/a.ts (mode=summary total_lines=231)\nsummary: src/a.ts'),
    ).toBeUndefined();
    expect(
      fileToolStats(
        'write',
        'write (path=src/new.ts bytes_written=4200 created=true)\n+++ src/new.ts\n+ (new file, 92 lines)',
      ),
    ).toEqual({ addedLines: 92, removedLines: 0, partial: false });
    expect(
      fileToolStats(
        'edit',
        'edit (path=src/a.ts replacements=1)\n--- src/a.ts\n+++ src/a.ts\n@@ -1,3 +1,3 @@\n keep\n-gone\n+fresh',
      ),
    ).toEqual({ addedLines: 1, removedLines: 1, partial: false });
    // No-op edits serialize no diff at all.
    expect(
      fileToolStats('edit', 'edit (path=src/a.ts replacements=0 note=(no-op: no match))'),
    ).toBeUndefined();
  });
  it('prefers the exact totals in a clipped diff_summary header', () => {
    // compactDiff emits `diff_summary (… added=N removed=N …)` with EXACT
    // counts over the full diff even when only 8 hunks are shown.
    const output = [
      'edit (path=src/big.ts replacements=9)',
      'diff_summary (files=1 hunks=9 shown_hunks=8 added=57 removed=12 lines=431)',
      '--- src/big.ts',
      '+++ src/big.ts',
      '@@ -1,2 +1,2 @@',
      ' ctx',
      '-old',
      '+new',
    ].join('\n');
    expect(fileToolStats('edit', output)).toEqual({
      addedLines: 57,
      removedLines: 12,
      partial: false,
    });
  });
  it('marks serialized diffs partial when the tool cut them in transit', () => {
    const output = [
      'edit (path=src/big.ts replacements=3)',
      '--- src/big.ts',
      '+++ src/big.ts',
      '@@ -1,2 +1,2 @@',
      ' ctx',
      '-old',
      '+new',
      '…[diff truncated: 9000 of 12000 bytes omitted]',
    ].join('\n');
    expect(fileToolStats('edit', output)).toEqual({
      addedLines: 1,
      removedLines: 1,
      partial: true,
    });
  });
});
