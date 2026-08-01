import { beforeEach, describe, expect, it } from 'vitest';
import {
  createToolOutputSerializer,
  sizeSignals,
  truncateForEvent,
} from '../../src/utils/tool-output-serializer.js';

describe('createToolOutputSerializer', () => {
  let serializer: ReturnType<typeof createToolOutputSerializer>;

  beforeEach(() => {
    serializer = createToolOutputSerializer();
  });

  describe('serialize', () => {
    it('returns string as-is', () => {
      expect(serializer.serialize('hello world')).toBe('hello world');
      expect(serializer.serialize('')).toBe('');
    });

    it('returns empty string for null', () => {
      expect(serializer.serialize(null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(serializer.serialize(undefined)).toBe('');
    });

    it('serializes array by joining with newlines', () => {
      expect(serializer.serialize(['a', 'b', 'c'])).toBe('a\nb\nc');
      expect(serializer.serialize(['line1', 'line2'])).toBe('line1\nline2');
    });

    it('extracts text property from object when string', () => {
      expect(serializer.serialize({ text: 'hello' })).toBe('hello');
    });

    it('falls back to JSON when text is not a string', () => {
      expect(serializer.serialize({ text: 123 })).toContain('"text"');
    });

    it('JSON stringifies objects without text property', () => {
      expect(serializer.serialize({ foo: 'bar' })).toBe('{\n  "foo": "bar"\n}');
    });

    it('renders read results with compact metadata when tool context is provided', () => {
      const out = serializer.serialize(
        { text: '1→const value = 1;', total_lines: 20, encoding: 'utf8', truncated: true },
        { toolName: 'read', input: { path: 'src/a.ts', offset: 1, limit: 1 } },
      );
      expect(out).toContain('read: src/a.ts');
      expect(out).toContain('total_lines=20');
      expect(out).toContain('truncated=true');
      expect(out).toContain('1→const value = 1;');
    });

    it('renders grep matches as line-oriented output instead of JSON', () => {
      const out = serializer.serialize(
        {
          matches: ['src/a.ts:1:Token', 'src/b.ts:2:Token'],
          count: 2,
          truncated: false,
          used: 'rg',
        },
        { toolName: 'grep', input: { pattern: 'Token' } },
      );
      expect(out).toBe(
        'grep: Token (count=2 shown=2 truncated=false used=rg)\n' +
          'src/a.ts (1 match(es), showing 1)\n1:Token\n' +
          'src/b.ts (1 match(es), showing 1)\n2:Token',
      );
      expect(out).not.toContain('"matches"');
    });

    it('renders command-like results with stdout and stderr blocks', () => {
      const out = serializer.serialize(
        {
          command: 'pnpm',
          args: ['test'],
          stdout: 'ok',
          stderr: 'failed',
          exitCode: 1,
          truncated: false,
          allowed: true,
        },
        { toolName: 'exec' },
      );
      expect(out).toBe(
        'exec: pnpm test (exit_code=1 allowed=true truncated=false)\n' +
          'stdout:\nok\nstderr:\nfailed',
      );
    });

    it('renders passing test results as a concise report without full output', () => {
      const out = serializer.serialize(
        {
          runner: 'vitest',
          exit_code: 0,
          tests_run: 12,
          passed: 12,
          failed: 0,
          duration_ms: 345,
          output: 'PASS a.test.ts\nPASS b.test.ts\nAll files listed here',
          truncated: false,
        },
        { toolName: 'test', input: { files: ['a.test.ts', 'b.test.ts'] } },
      );
      expect(out).toContain('test: vitest');
      expect(out).toContain('status=passed');
      expect(out).toContain('tests_run=12');
      expect(out).not.toContain('PASS a.test.ts');
      expect(out).not.toContain('All files listed here');
    });

    it('keeps failure context for test results and omits unrelated long output', () => {
      const noise = Array.from({ length: 300 }, (_, i) => `PASS test-${i}.ts`).join('\n');
      const out = serializer.serialize(
        {
          runner: 'vitest',
          exit_code: 1,
          tests_run: 301,
          passed: 300,
          failed: 1,
          duration_ms: 999,
          output: `${noise}\nFAIL src/a.test.ts\nAssertionError: expected 1 to be 2\nExpected: 2\nReceived: 1`,
          truncated: false,
        },
        { toolName: 'test' },
      );
      expect(out).toContain('error_context:');
      expect(out).toContain('FAIL src/a.test.ts');
      expect(out).toContain('AssertionError');
      expect(out).toContain('serializer omitted');
      expect(out).not.toContain('PASS test-10.ts');
    });

    it('renders diff outputs as diffs even when they include a files array', () => {
      const out = serializer.serialize(
        {
          diff: 'diff --git a/a.ts b/a.ts\n+const value = 1;',
          files: ['a.ts'],
          truncated: false,
          mode: 'unified',
        },
        { toolName: 'diff' },
      );
      expect(out).toContain('diff (files=1 truncated=false mode=unified)');
      expect(out).toContain('diff --git');
    });

    it('summarizes very large diffs while keeping hunk context', () => {
      const bigDiff = [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,300 +1,300 @@',
        ...Array.from({ length: 320 }, (_, i) => (i % 2 === 0 ? `-old${i}` : `+new${i}`)),
      ].join('\n');
      const out = serializer.serialize(
        {
          diff: bigDiff,
          files: ['a.ts'],
          truncated: false,
          mode: 'unified',
        },
        { toolName: 'diff' },
      );
      expect(out).toContain('diff_summary');
      expect(out).toContain('shown_hunks=1');
      expect(out).toContain('@@ -1,300 +1,300 @@');
      expect(out).toContain('serializer omitted');
      expect(out).not.toContain('new319');
    });

    it('includes edit notes in compact diff headers', () => {
      const out = serializer.serialize(
        {
          path: 'a.ts',
          replacements: 1,
          note: 'auto-read current file before editing',
          diff: '--- a.ts\n+++ a.ts\n-old\n+new',
        },
        { toolName: 'edit' },
      );
      expect(out).toContain('note=auto-read current file before editing');
      expect(out).toContain('--- a.ts');
    });

    it('renders successful verifier outputs without full logs', () => {
      const out = serializer.serialize(
        {
          project: 'tsconfig.json',
          exit_code: 0,
          errors: 0,
          warnings: 0,
          output: 'Found 0 errors. Very long diagnostic banner.',
          truncated: false,
        },
        { toolName: 'typecheck' },
      );
      expect(out).toContain('typecheck');
      expect(out).toContain('status=passed');
      expect(out).not.toContain('Very long diagnostic banner');
    });

    it('keeps verifier failure context', () => {
      const noise = Array.from({ length: 280 }, (_, i) => `ok ${i}`).join('\n');
      const out = serializer.serialize(
        {
          linter: 'biome',
          exit_code: 1,
          errors: 1,
          warnings: 0,
          output: `${noise}\nsrc/a.ts:1:1 error lint/suspicious/noConsole\nUnexpected console.log`,
          truncated: false,
        },
        { toolName: 'lint' },
      );
      expect(out).toContain('error_context');
      expect(out).toContain('src/a.ts:1:1 error');
      expect(out).toContain('serializer omitted');
      expect(out).not.toContain('ok 10');
    });

    it('renders unknown tool objects compactly when tool context is provided', () => {
      const out = serializer.serialize(
        {
          status: 'ok',
          note: 'x'.repeat(300),
          items: ['a', 'b'],
        },
        { toolName: 'custom' },
      );
      expect(out).toContain('custom (status=ok)');
      expect(out).toContain('note:\n');
      expect(out).toContain('items:\na\nb');
      expect(out).not.toContain('{\n  "status"');
    });

    it('falls back to String() when JSON.stringify throws on circular refs', () => {
      const circular: Record<string, unknown> = { name: 'cyc' };
      circular.self = circular;
      // The fallback path returns the result of String(value) — for plain
      // objects this is "[object Object]". The important contract is it
      // does NOT throw.
      expect(() => serializer.serialize(circular)).not.toThrow();
      expect(serializer.serialize(circular)).toBe('[object Object]');
    });

    it('handles numbers and booleans via String() fallback', () => {
      expect(serializer.serialize(42)).toBe('42');
      expect(serializer.serialize(true)).toBe('true');
      expect(serializer.serialize(false)).toBe('false');
    });
  });

  describe('enforceCap', () => {
    it('returns text unchanged when within budget', () => {
      const result = serializer.enforceCap('hello', 1000);
      expect(result.text).toBe('hello');
      expect(result.newBudget).toBeGreaterThan(0);
    });

    it('returns text unchanged when exact budget matches', () => {
      const result = serializer.enforceCap('hello', 5);
      expect(result.text).toBe('hello');
    });

    it('returns truncated message when budget is zero', () => {
      const result = serializer.enforceCap('hello', 0);
      expect(result.text).toBe('[truncated: iteration output cap exceeded]');
      expect(result.newBudget).toBe(0);
    });

    it('returns truncated message when budget is negative', () => {
      const result = serializer.enforceCap('hello', -1);
      expect(result.text).toBe('[truncated: iteration output cap exceeded]');
    });

    it('truncates middle of text when exceeds budget', () => {
      const result = serializer.enforceCap('0123456789', 5);
      expect(result.text).not.toBe('0123456789');
      expect(result.text).toContain('truncated');
      expect(result.newBudget).toBe(0);
    });

    it('includes byte count in truncation marker', () => {
      const result = serializer.enforceCap('0123456789', 5);
      expect(result.text).toContain('truncated');
    });

    it('returns truncated message when available space after marker is too small', () => {
      // When remaining budget minus marker is <= 0
      const result = serializer.enforceCap('long text here', 10);
      expect(result.text).toContain('[truncated');
    });

    it('splits text when exceeds budget', () => {
      // Use text 20 bytes with budget 20 (should fit exactly)
      const result1 = serializer.enforceCap('abcdefghijklmnopqrst', 20);
      expect(result1.text).toBe('abcdefghijklmnopqrst');
      // Use text 30 bytes with budget 20 (should truncate)
      const result = serializer.enforceCap('abcdefghijklmnopqrstuvwxyz', 20);
      expect(result.text).not.toBe('abcdefghijklmnopqrstuvwxyz');
      // budget 20 minus marker bytes is negative, so returns simple truncation
      expect(result.text).toContain('[truncated');
      expect(result.newBudget).toBe(0);
    });

    it('keeps head + tail with marker when budget has room for both', () => {
      // 1000-byte budget against 2000-byte text → marker fits, head+tail are nonempty.
      const text = 'A'.repeat(1000) + 'B'.repeat(1000);
      const result = serializer.enforceCap(text, 200);
      // We should see the marker between two slices.
      expect(result.text).toMatch(/A+\n…\[truncated \d+ bytes\]…\nB+/);
      expect(result.newBudget).toBe(0);
    });

    it('enforces the cap in UTF-8 bytes for multibyte output', () => {
      const result = serializer.enforceCap('😀'.repeat(1_000), 200);

      expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(200);
      expect(result.text).not.toContain('�');
      expect(result.newBudget).toBe(0);
    });

    it('uses custom perIterationOutputCapBytes', () => {
      const custom = createToolOutputSerializer({ perIterationOutputCapBytes: 50 });
      expect(custom.capBytes).toBe(50);
    });

    it('estimator option is accepted but not used in enforceCap', () => {
      const custom = createToolOutputSerializer({ estimator: () => 100 });
      // estimator is stored but enforceCap still uses Buffer.byteLength
      expect(() => custom.enforceCap('a'.repeat(50), 1000)).not.toThrow();
    });

    it('decreases remaining budget', () => {
      const { newBudget } = serializer.enforceCap('hello', 1000);
      expect(newBudget).toBeLessThan(1000);
    });

    it('newBudget becomes 0 when cap exceeded', () => {
      const { newBudget } = serializer.enforceCap('a'.repeat(10000), 10);
      expect(newBudget).toBe(0);
    });
  });

  describe('capBytes', () => {
    it('defaults to 100000', () => {
      expect(serializer.capBytes).toBe(100_000);
    });

    it('uses custom value', () => {
      const custom = createToolOutputSerializer({ perIterationOutputCapBytes: 5000 });
      expect(custom.capBytes).toBe(5000);
    });
  });
});

// ── Extended coverage: remaining tool renderers + edge branches ─────────────

describe('createToolOutputSerializer (extended)', () => {
  let serializer: ReturnType<typeof createToolOutputSerializer>;
  beforeEach(() => {
    serializer = createToolOutputSerializer();
  });

  it('renders patch results (applied/rejected + files list + message)', () => {
    const out = serializer.serialize(
      { files: ['a.ts', 'b.ts'], applied: 2, rejected: 0, dry_run: false, message: 'ok' },
      { toolName: 'patch' },
    );
    expect(out).toContain('applied=2');
    expect(out).toContain('rejected=0');
    expect(out).toContain('files=2');
    expect(out).toContain('message:');
    expect(out).toContain('a.ts');
  });

  it('renders glob results with the pattern + file list', () => {
    const out = serializer.serialize(
      { files: ['a.ts', 'b.ts'], truncated: false },
      { toolName: 'glob', input: { pattern: '*.ts' } },
    );
    expect(out).toContain('glob: *.ts');
    expect(out).toContain('files=2');
    expect(out).toContain('a.ts');
  });

  it('renders tree results', () => {
    const out = serializer.serialize(
      { tree: 'root\n  f.ts', total_files: 1, total_dirs: 1, truncated: false },
      { toolName: 'tree' },
    );
    expect(out).toContain('tree:');
    expect(out).toContain('total_files=1');
    expect(out).toContain('root');
  });

  it('renders fetch results', () => {
    const out = serializer.serialize(
      { content: '<html/>', status: 200, content_type: 'text/html' },
      { toolName: 'fetch', input: { url: 'http://x' } },
    );
    expect(out).toContain('fetch: http://x');
    expect(out).toContain('status=200');
    expect(out).toContain('<html/>');
  });

  it('renders replace results per-file + omits beyond the list limit', () => {
    const results = Array.from({ length: 501 }, (_, i) => ({
      path: `f${i}.ts`,
      replacements: 1,
      diff: '+x',
    }));
    const out = serializer.serialize(
      { results, files_modified: 501, total_replacements: 501, dry_run: false },
      { toolName: 'replace' },
    );
    expect(out).toContain('replace (files_modified=501');
    expect(out).toContain('file: f0.ts');
    expect(out).toContain('serializer omitted 1 result item');
  });

  it('renders json results', () => {
    const out = serializer.serialize(
      { formatted: '{ "a": 1 }', type: 'object', keys: ['a'], error: undefined },
      { toolName: 'json', input: { query: '$.a' } },
    );
    expect(out).toContain('json (type=object keys=1 query=$.a)');
    expect(out).toContain('{ "a": 1 }');
  });

  it('renders logs entries + omits beyond the entry limit', () => {
    const entries = Array.from({ length: 201 }, (_, i) => ({
      timestamp: 't',
      level: 'info',
      message: `m${i}`,
      source: 's',
    }));
    const out = serializer.serialize(
      { entries, total: 201, source: 'app', truncated: false, stream_mode: false },
      { toolName: 'logs' },
    );
    expect(out).toContain('logs: app');
    expect(out).toContain('shown=200');
    expect(out).toContain('serializer omitted 1 log entry');
  });

  it('renders empty logs as (no log entries)', () => {
    const out = serializer.serialize(
      { entries: [], total: 0, source: 'app' },
      { toolName: 'logs' },
    );
    expect(out).toContain('(no log entries)');
  });

  it('renders audit vulnerabilities + omits beyond the limit', () => {
    // No exit_code/output — those would trip hasCommandOutputShape before the audit branch.
    const vulns = Array.from({ length: 501 }, (_, i) => ({
      severity: 'high',
      package: `p${i}`,
      title: 't',
      url: 'u',
    }));
    const out = serializer.serialize(
      { vulnerabilities: vulns, total: 501, truncated: false },
      { toolName: 'audit' },
    );
    expect(out).toContain('audit (');
    expect(out).toContain('total=501');
    expect(out).toContain('serializer omitted 1 vulnerability');
  });

  it('renders audit with no vulns (empty body)', () => {
    const out = serializer.serialize({ vulnerabilities: [], total: 0 }, { toolName: 'audit' });
    expect(out).toContain('audit (');
  });

  it('renders outdated packages + omits beyond the limit', () => {
    const packages = Array.from({ length: 501 }, (_, i) => ({
      name: `p${i}`,
      current: '1',
      wanted: '1',
      latest: '2',
      type: 'deps',
    }));
    const out = serializer.serialize(
      { packages, total: 501, truncated: false },
      { toolName: 'outdated' },
    );
    expect(out).toContain('outdated (');
    expect(out).toContain('total=501');
    expect(out).toContain('serializer omitted 1 package');
  });

  it('renders outdated with no packages (empty body)', () => {
    const out = serializer.serialize({ packages: [], total: 0 }, { toolName: 'outdated' });
    expect(out).toContain('outdated (');
  });

  it('renders grep in files_with_matches mode', () => {
    const out = serializer.serialize(
      { matches: ['src/a.ts', 'src/b.ts'], count: 2 },
      { toolName: 'grep', input: { pattern: 'X', output_mode: 'files_with_matches' } },
    );
    expect(out).toContain('src/a.ts');
    expect(out).toContain('src/b.ts');
  });

  it('renders grep in count mode', () => {
    const out = serializer.serialize(
      { matches: ['src/a.ts:5'], count: 1 },
      { toolName: 'grep', input: { pattern: 'X', output_mode: 'count' } },
    );
    expect(out).toContain('src/a.ts:5');
  });

  it('renders grep with ungrouped (non-parseable) matches as passthrough', () => {
    const out = serializer.serialize(
      { matches: ['not-a-match-line', 'src/a.ts:1:Token'] },
      { toolName: 'grep', input: { pattern: 'X' } },
    );
    expect(out).toContain('ungrouped:');
    expect(out).toContain('not-a-match-line');
  });

  it('renders grep with no matches', () => {
    const out = serializer.serialize(
      { matches: [], count: 0 },
      { toolName: 'grep', input: { pattern: 'X' } },
    );
    expect(out).toContain('(no matches)');
  });

  it('omits grep file groups beyond the file limit', () => {
    const matches = Array.from({ length: 81 }, (_, i) => `f${i}.ts:1:Token`);
    const out = serializer.serialize(
      { matches, count: 81 },
      { toolName: 'grep', input: { pattern: 'X' } },
    );
    expect(out).toContain('serializer omitted');
  });

  it('summarizes a long diff with no diff/hunk markers (empty-intervals branch)', () => {
    // >260 lines, none starting with 'diff --git'/'--- '/'+++ '/'@@'
    const lines = Array.from({ length: 300 }, (_, i) => `plain line ${i}`);
    const out = serializer.serialize({ diff: lines.join('\n') }, { toolName: 'diff' });
    expect(out).toContain('diff_summary');
    expect(out).toContain('serializer omitted');
  });

  it('keeps the tail of a long failure output with no marker words', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    const out = serializer.serialize(
      { runner: 'vitest', exit_code: 1, output: lines.join('\n') },
      { toolName: 'test' },
    );
    expect(out).toContain('error_context');
    expect(out).toContain('line 299');
  });

  it('renders a format run that changed files as status=changed', () => {
    const out = serializer.serialize(
      { exit_code: 0, errors: 0, warnings: 0, files_changed: 3, output: 'formatted' },
      { toolName: 'format' },
    );
    expect(out).toContain('status=changed');
    expect(out).toContain('files_changed=3');
  });

  it('delegates to context.tool.serialize when present', () => {
    const out = serializer.serialize(
      { a: 1 },
      { toolName: 'custom', tool: { serialize: (v: unknown) => `CUSTOM:${JSON.stringify(v)}` } },
    );
    expect(out).toBe('CUSTOM:{"a":1}');
  });

  it('falls through to the central renderer when context.tool.serialize throws', () => {
    const out = serializer.serialize(
      { text: 'body', total_lines: 1 },
      {
        toolName: 'read',
        input: { path: 'a.ts' },
        tool: {
          serialize: () => {
            throw new Error('boom');
          },
        },
      },
    );
    expect(out).toContain('read: a.ts');
    expect(out).toContain('body');
  });

  it('renders a generic object with a non-string array + a nested object value', () => {
    const out = serializer.serialize(
      { items: [{ x: 1 }], nested: { a: 1 }, ok: true },
      { toolName: 'custom' },
    );
    expect(out).toContain('custom (ok=true)');
    expect(out).toContain('items:');
    expect(out).toContain('nested:');
  });

  it('summarizes a diff with many separated hunks (hunk cap + interval gaps)', () => {
    const lines = ['diff --git a/a b/a', '--- a/a', '+++ a/a'];
    for (let h = 0; h < 10; h++) {
      lines.push(`@@ -${h * 30 + 1},3 +${h * 30 + 1},3 @@`);
      lines.push(` ctx ${h}-1`, `+new ${h}`, ` ctx ${h}-2`);
      for (let g = 0; g < 25; g++) lines.push(` pad ${h}-${g}`); // create gaps + exceed 260 lines
    }
    const out = serializer.serialize({ diff: lines.join('\n') }, { toolName: 'diff' });
    expect(out).toContain('diff_summary');
    expect(out).toContain('serializer omitted');
  });

  it('returns a short failure output trimmed (≤260 lines, no compaction)', () => {
    const out = serializer.serialize(
      { runner: 'vitest', exit_code: 1, output: 'FAIL a\nexpected 1 to be 2' },
      { toolName: 'test' },
    );
    expect(out).toContain('error_context');
    expect(out).toContain('expected 1 to be 2');
  });

  it('renders a command result with an error field', () => {
    const out = serializer.serialize(
      { command: 'x', args: [], error: 'boom', exit_code: 1 },
      { toolName: 'exec' },
    );
    expect(out).toContain('error:');
    expect(out).toContain('boom');
  });

  it('renders a read result without input (numberFromInput non-record)', () => {
    const out = serializer.serialize({ text: 'body', total_lines: 1 }, { toolName: 'read' });
    expect(out).toContain('read:');
    expect(out).toContain('body');
  });

  it('renders a test result with a string files input', () => {
    const out = serializer.serialize(
      { runner: 'vitest', exit_code: 0, tests_run: 1, passed: 1, failed: 0, output: 'ok' },
      { toolName: 'test', input: { files: 'a.test.ts' } },
    );
    expect(out).toContain('status=passed');
  });

  it('renders a generic object whose nested value is circular (oneLineJson fallback)', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => serializer.serialize({ nested: circular }, { toolName: 'custom' })).not.toThrow();
  });

  it('skips undefined fields in a generic object render', () => {
    const out = serializer.serialize({ a: 1, b: undefined, c: 'x' }, { toolName: 'custom' });
    expect(out).toContain('a=1');
    expect(out).toContain('c=x');
  });

  it('omits glob files beyond the list limit', () => {
    const files = Array.from({ length: 501 }, (_, i) => `f${i}.ts`);
    const out = serializer.serialize({ files }, { toolName: 'glob', input: { pattern: '*.ts' } });
    expect(out).toContain('serializer omitted 1 item');
  });

  it('renders an empty glob result with the empty placeholder', () => {
    const out = serializer.serialize(
      { files: [] },
      { toolName: 'glob', input: { pattern: '*.ts' } },
    );
    expect(out).toContain('(no files)');
  });

  it('omits generic non-string list items beyond the limit (renderUnknownList)', () => {
    const items = Array.from({ length: 501 }, () => ({ x: 1 }));
    const out = serializer.serialize({ items }, { toolName: 'custom' });
    expect(out).toContain('serializer omitted 1 item');
  });

  it('inputListSummary returns undefined for a non-string/non-array files value', () => {
    const out = serializer.serialize(
      { runner: 'v', exit_code: 0, tests_run: 1, passed: 1, failed: 0, output: 'ok' },
      { toolName: 'test', input: { files: 5 } },
    );
    expect(out).toContain('status=passed');
  });

  it('renders an object-valued header field via oneLineJson', () => {
    // `note` is an object → formatInlineValue falls through to oneLineJson.
    const out = serializer.serialize(
      { text: 'body', total_lines: 1, note: { weird: true } },
      { toolName: 'read', input: { path: 'a.ts' } },
    );
    expect(out).toContain('read: a.ts');
    expect(out).toContain('weird');
  });
});

describe('truncateForEvent', () => {
  it('returns empty for empty content', () => {
    expect(truncateForEvent('')).toBe('');
  });
  it('returns short content unchanged', () => {
    expect(truncateForEvent('short')).toBe('short');
  });
  it('truncates long content with an ellipsis', () => {
    const out = truncateForEvent('a'.repeat(500), 400);
    expect(out.length).toBe(400);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('sizeSignals', () => {
  it('returns zeros + undefined lines for empty content', () => {
    expect(sizeSignals('read', '')).toEqual({
      outputBytes: 0,
      outputTokens: 0,
      outputLines: undefined,
    });
  });
  it('counts read line prefixes', () => {
    const s = sizeSignals('read', '1→a\n2→b\n3→c');
    expect(s.outputLines).toBe(3);
    expect(s.outputBytes).toBeGreaterThan(0);
    expect(s.outputTokens).toBeGreaterThan(0);
  });
  it('counts newlines for bash/grep/logs', () => {
    expect(sizeSignals('bash', 'a\nb\nc').outputLines).toBe(3);
    expect(sizeSignals('grep', 'x\ny').outputLines).toBe(2);
    expect(sizeSignals('logs', 'x\ny\n').outputLines).toBe(2);
    expect(sizeSignals('shell', 'a\nb').outputLines).toBe(2);
  });
  it('leaves lines undefined for other tools', () => {
    expect(sizeSignals('edit', 'a\nb\nc').outputLines).toBeUndefined();
  });
});
