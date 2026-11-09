import { describe, expect, it } from 'vitest';
import {
  computeLineDiff,
  DIFF_LINE_SAFETY_CAP,
  diffFromToolInput,
  diffRowsFromToolInput,
  parseUnifiedDiff,
  parseUnifiedDiffPreview,
  TOOL_DIFF_BROWSER_SRC,
  truncMid,
} from '../src/tool-diff.js';

describe('diffFromToolInput', () => {
  it('extracts an lcs diff from edit', () => {
    expect(diffFromToolInput('edit', { path: 'a.ts', old_string: 'x', new_string: 'y' })).toEqual({
      mode: 'lcs',
      oldText: 'x',
      newText: 'y',
      caption: 'edit a.ts',
    });
  });

  it('treats write as all-additions', () => {
    expect(diffFromToolInput('write', { file_path: 'new.ts', content: 'a\nb' })).toEqual({
      mode: 'lcs',
      oldText: '',
      newText: 'a\nb',
      caption: 'write new.ts (new)',
    });
  });

  it('extracts a unified diff from patch', () => {
    const patch = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n';
    expect(diffFromToolInput('patch', { patch })).toEqual({
      mode: 'unified',
      patchText: patch,
      caption: 'patch',
    });
  });

  it('captions patch with the file path when present', () => {
    expect(
      diffFromToolInput('patch', { patch: '@@ -1 +1 @@\n-a\n+b', path: 'x.ts' })?.caption,
    ).toBe('patch x.ts');
  });

  it('returns null for non-diff tools and empty input', () => {
    expect(diffFromToolInput('bash', { command: 'ls' })).toBeNull();
    expect(diffFromToolInput('edit', { old_string: '', new_string: '' })).toBeNull();
    expect(diffFromToolInput('write', { content: '' })).toBeNull();
    expect(diffFromToolInput('patch', { patch: '   ' })).toBeNull();
    expect(diffFromToolInput(undefined, { old_string: 'x' })).toBeNull();
  });

  it('accepts a JSON string identically to a parsed object', () => {
    const obj = { path: 'a.ts', old_string: 'x', new_string: 'y' };
    expect(diffFromToolInput('edit', JSON.stringify(obj))).toEqual(diffFromToolInput('edit', obj));
  });
});

describe('computeLineDiff', () => {
  it('marks add/del/ctx rows', () => {
    expect(computeLineDiff('a\nb\nc', 'a\nX\nc')).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'X' },
      { kind: 'ctx', text: 'c' },
    ]);
  });

  it('all additions for empty old', () => {
    expect(computeLineDiff('', 'a')).toEqual([
      { kind: 'del', text: '' },
      { kind: 'add', text: 'a' },
    ]);
  });

  it('returns null past the line cap', () => {
    const huge = new Array(5002).fill('x').join('\n');
    expect(computeLineDiff(huge, 'a')).toBeNull();
  });
});

describe('parseUnifiedDiff', () => {
  it('maps hunk headers to meta and +/- to add/del', () => {
    const rows = parseUnifiedDiff('@@ -1,2 +1,2 @@\n ctx\n-old\n+new');
    expect(rows).toEqual([
      { kind: 'meta', text: '@@ -1,2 +1,2 @@' },
      { kind: 'ctx', text: 'ctx' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
    ]);
  });

  it('treats file headers as meta', () => {
    const rows = parseUnifiedDiff('--- a/x\n+++ b/x\n diff-body');
    expect(rows[0]).toEqual({ kind: 'meta', text: '--- a/x' });
    expect(rows[1]).toEqual({ kind: 'meta', text: '+++ b/x' });
  });

  it('keeps body lines that merely start with --- or +++ as changes', () => {
    const rows = parseUnifiedDiff(BODY_LOOKS_LIKE_HEADER);
    expect(rows.filter((r) => r.kind !== 'meta')).toEqual([
      { kind: 'del', text: '-- drop table t;' },
      { kind: 'del', text: '---' },
      { kind: 'add', text: '++i;' },
      { kind: 'ctx', text: 'end' },
    ]);
  });
});

const BODY_LOOKS_LIKE_HEADER =
  '--- a/x\n+++ b/x\n@@ -1,3 +1,2 @@\n--- drop table t;\n----\n+++i;\n end\n';

// ---------------------------------------------------------------------------
// Parity: the HQ browser transcription must match the TS implementation.
// ---------------------------------------------------------------------------
const bs = new Function(
  `${TOOL_DIFF_BROWSER_SRC}\nreturn { diffFromToolInput, computeLineDiff, parseUnifiedDiff, diffRowsFromToolInput };`,
)() as {
  diffFromToolInput: (n: string | undefined, i: unknown) => unknown;
  computeLineDiff: (a: string, b: string) => unknown;
  parseUnifiedDiff: (p: string) => unknown;
  diffRowsFromToolInput: (n: string | undefined, i: string | null) => unknown;
};

describe('tool-diff parity (TS vs embedded browser source)', () => {
  const diffCases: Array<{ tool: string | undefined; input: unknown }> = [
    { tool: 'edit', input: { path: '/foo/bar.ts', old_string: 'a\nb\nc', new_string: 'a\nX\nc' } },
    { tool: 'str_replace', input: { file_path: 't.ts', old_string: '1\n2', new_string: '' } },
    { tool: 'write', input: { path: 'new.ts', content: 'line1\nline2\nline3' } },
    { tool: 'create_file', input: { file_path: 'c.ts', content: 'only' } },
    // Parity regressions (2026-08-31): the browser write-caption collapsed
    // inner whitespace runs where the TS `.trim()` preserves them — and the
    // two diverged when file_path was absent. These cases lock both shapes.
    { tool: 'write', input: { content: 'a\nb' } },
    { tool: 'write', input: { file_path: 'my  folder/a  b.ts', content: 'x' } },
    { tool: 'write', input: { file_path: 'dir/\ta.ts', content: 'x' } },
    {
      tool: 'patch',
      input: { patch: '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n', path: 'x.ts' },
    },
    { tool: 'bash', input: { command: 'ls' } },
    { tool: 'edit', input: { old_string: '', new_string: '' } },
    { tool: undefined, input: { old_string: 'x' } },
  ];

  for (let idx = 0; idx < diffCases.length; idx++) {
    const c = diffCases[idx]!;
    it(`diffFromToolInput parity #${idx} (${c.tool ?? 'undefined'})`, () => {
      const ts = diffFromToolInput(c.tool, c.input);
      const browser = bs.diffFromToolInput(c.tool, JSON.stringify(c.input));
      expect(browser).toEqual(ts);
    });
    it(`diffRowsFromToolInput parity #${idx} (${c.tool ?? 'undefined'})`, () => {
      const ts = diffRowsFromToolInput(c.tool, c.input);
      const browser = bs.diffRowsFromToolInput(c.tool, JSON.stringify(c.input));
      expect(browser).toEqual(ts);
    });
  }

  const lcsPairs: Array<[string, string]> = [
    ['a\nb\nc', 'a\nX\nc'],
    ['', 'new'],
    ['same', 'same'],
    ['1\n2\n3\n4', '1\n3\n4\n5'],
  ];
  for (let idx = 0; idx < lcsPairs.length; idx++) {
    const [a, b] = lcsPairs[idx]!;
    it(`computeLineDiff parity #${idx}`, () => {
      expect(bs.computeLineDiff(a, b)).toEqual(computeLineDiff(a, b));
    });
  }

  it('parseUnifiedDiff parity', () => {
    const patch =
      'diff --git a/x b/x\nindex 111..222\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n';
    expect(bs.parseUnifiedDiff(patch)).toEqual(parseUnifiedDiff(patch));
    expect(bs.parseUnifiedDiff(BODY_LOOKS_LIKE_HEADER)).toEqual(
      parseUnifiedDiff(BODY_LOOKS_LIKE_HEADER),
    );
    // The write tool's new-file diff: a lone `+++` header before any hunk.
    const lone = '+++ src/new.ts\n+ (new file)';
    expect(parseUnifiedDiff(lone)[0]).toEqual({ kind: 'meta', text: '+++ src/new.ts' });
    expect(bs.parseUnifiedDiff(lone)).toEqual(parseUnifiedDiff(lone));
  });
});

// ---------------------------------------------------------------------------
// Rich preview model — promoted from the TUI. These assertions pin the exact
// behavior the TUI's code-block.tsx relied on (gutter line numbers, hunk kind,
// hidden counts, maxLines cap) so the TUI delegating here can't regress.
// ---------------------------------------------------------------------------
describe('parseUnifiedDiffPreview (rich, TUI-promoted)', () => {
  it('tracks old/new line gutters and a dedicated hunk kind', () => {
    const p = parseUnifiedDiffPreview(
      '@@ -10,2 +10,2 @@\n ctx\n-old\n+new',
      Number.POSITIVE_INFINITY,
    );
    // Note: context and +/- rows keep their raw leading marker/space (' ctx',
    // '-old', '+new') — the terminal renderer strips/colours the marker itself.
    expect(p.rows).toEqual([
      { kind: 'hunk', text: '@@ -10,2 +10,2 @@' },
      { kind: 'ctx', text: ' ctx', oldLine: 10, newLine: 10 },
      { kind: 'del', text: '-old', oldLine: 11 },
      { kind: 'add', text: '+new', newLine: 11 },
    ]);
    expect(p.added).toBe(1);
    expect(p.removed).toBe(1);
    expect(p.hidden).toBe(0);
  });

  it('drops +++/---/diff/index header lines', () => {
    const p = parseUnifiedDiffPreview(
      'diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b',
      Number.POSITIVE_INFINITY,
    );
    expect(p.rows.map((r) => r.kind)).toEqual(['hunk', 'del', 'add']);
  });

  it('keeps a removed `---` line and the line numbers after it', () => {
    const p = parseUnifiedDiffPreview(BODY_LOOKS_LIKE_HEADER, Number.POSITIVE_INFINITY);
    expect(p.rows.filter((r) => r.kind !== 'hunk')).toEqual([
      { kind: 'del', text: '--- drop table t;', oldLine: 1 },
      { kind: 'del', text: '----', oldLine: 2 },
      { kind: 'add', text: '+++i;', newLine: 1 },
      { kind: 'ctx', text: ' end', oldLine: 3, newLine: 2 },
    ]);
    expect(p.removed).toBe(2);
  });

  it('folds overflow into hidden counts at the maxLines cap', () => {
    const diff = '@@ -1,4 +1,4 @@\n+a\n+b\n+c\n+d';
    const p = parseUnifiedDiffPreview(diff, 3);
    expect(p.rows).toHaveLength(3); // hunk + 2 adds
    expect(p.hidden).toBe(2);
    expect(p.added).toBe(4);
    expect(p.hiddenAdded).toBe(2);
  });

  it('returns an empty preview for an empty diff', () => {
    expect(parseUnifiedDiffPreview('', Number.POSITIVE_INFINITY)).toEqual({
      rows: [],
      hidden: 0,
      added: 0,
      removed: 0,
      hiddenAdded: 0,
      hiddenRemoved: 0,
    });
  });

  it('truncMid caps a single row past the safety cap', () => {
    const long = `+${'x'.repeat(DIFF_LINE_SAFETY_CAP + 50)}`;
    const p = parseUnifiedDiffPreview(long, Number.POSITIVE_INFINITY);
    expect(p.rows[0]!.text.length).toBe(DIFF_LINE_SAFETY_CAP);
    expect(p.rows[0]!.text.endsWith('…')).toBe(true);
  });

  it('truncMid leaves short strings untouched', () => {
    expect(truncMid('short', 100)).toBe('short');
    expect(truncMid('abcdef', 4)).toBe('abc…');
    expect(truncMid('abcdef', 0)).toBe('');
    expect(truncMid('abcdef', -5)).toBe('');
    expect(truncMid('abcdef', 1)).toBe('…');
  });

  it('parseUnifiedDiffPreview treats negative or NaN maxLines as 0 visible rows (F138)', () => {
    const diff = '@@ -1,2 +1,2 @@\n-old\n+new';
    const neg = parseUnifiedDiffPreview(diff, -2);
    expect(neg.rows).toHaveLength(0);
    expect(neg.hidden).toBe(3);

    const nanCap = parseUnifiedDiffPreview(diff, Number.NaN);
    expect(nanCap.rows).toHaveLength(0);
    expect(nanCap.hidden).toBe(3);
  });

  describe('truncMid surrogate pairs', () => {
    const lone = (s: string): boolean =>
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

    it('never cuts an emoji in half', () => {
      // max 10 puts the cut at index 9, between the halves of the 5th emoji.
      const out = truncMid('😀'.repeat(20), 10);
      expect(lone(out)).toBe(false);
      expect(out.length).toBeLessThanOrEqual(10);
      expect(out.endsWith('…')).toBe(true);
    });

    it('keeps a full pair when the cut lands on a pair boundary', () => {
      // max 9 -> cut index 8, after four whole emoji.
      expect(truncMid('😀'.repeat(20), 9)).toBe(`${'😀'.repeat(4)}…`);
    });

    it('keeps a diff row well-formed at the per-row safety cap', () => {
      const p = parseUnifiedDiffPreview(`@@ -1,1 +1,1 @@\n+a${'😀'.repeat(40)}\n`, 50, 10);
      const add = p.rows.find((r) => r.kind === 'add');
      expect(add).toBeDefined();
      expect(lone(add?.text ?? '')).toBe(false);
    });
  });
});
