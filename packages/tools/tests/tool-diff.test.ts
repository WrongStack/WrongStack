import { describe, expect, it } from 'vitest';
import {
  TOOL_DIFF_BROWSER_SRC,
  computeLineDiff,
  diffFromToolInput,
  diffRowsFromToolInput,
  parseUnifiedDiff,
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
    expect(diffFromToolInput('patch', { patch })).toEqual({ mode: 'unified', patchText: patch, caption: 'patch' });
  });

  it('captions patch with the file path when present', () => {
    expect(diffFromToolInput('patch', { patch: '@@ -1 +1 @@\n-a\n+b', path: 'x.ts' })?.caption).toBe('patch x.ts');
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
});

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
    { tool: 'patch', input: { patch: '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n', path: 'x.ts' } },
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
    const patch = 'diff --git a/x b/x\nindex 111..222\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n';
    expect(bs.parseUnifiedDiff(patch)).toEqual(parseUnifiedDiff(patch));
  });
});
