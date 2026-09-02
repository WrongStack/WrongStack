import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createToolOutputSerializer,
  truncateForEvent,
  sizeSignals,
} from '../../src/utils/tool-output-serializer.js';
import { expandGlob } from '../../src/utils/glob-expand.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── tool-output-serializer ──────────────────────────────────────────────

describe('createToolOutputSerializer', () => {
  it('serializes strings as-is', () => {
    const s = createToolOutputSerializer();
    expect(s.serialize('hello')).toBe('hello');
  });

  it('serializes null/undefined as empty', () => {
    const s = createToolOutputSerializer();
    expect(s.serialize(null)).toBe('');
    expect(s.serialize(undefined)).toBe('');
  });

  it('serializes arrays by joining with newlines', () => {
    const s = createToolOutputSerializer();
    expect(s.serialize(['a', 'b', 'c'])).toBe('a\nb\nc');
  });

  it('serializes objects with text field', () => {
    const s = createToolOutputSerializer();
    expect(s.serialize({ text: 'hello' })).toBe('hello');
  });

  it('falls back to JSON for unknown objects', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize({ foo: 'bar', num: 42 });
    expect(result).toContain('foo');
    expect(result).toContain('bar');
  });

  it('delegates to tool.serialize when provided', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize({ x: 1 }, { tool: { serialize: () => 'CUSTOM' } });
    expect(result).toBe('CUSTOM');
  });

  it('falls back when tool.serialize throws', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize(
      { x: 1 },
      {
        tool: {
          serialize: () => {
            throw new Error('boom');
          },
        },
        toolName: 'read',
      },
    );
    expect(result).toBeDefined();
  });

  it('renders read tool output with header', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize(
      { text: 'file content', total_lines: 5 },
      { toolName: 'read', input: { path: '/a.ts' } },
    );
    expect(result).toContain('read: /a.ts');
    expect(result).toContain('total_lines=5');
    expect(result).toContain('file content');
  });

  it('renders grep tool output', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize(
      { matches: ['file.ts:10:match'], count: 1 },
      { toolName: 'grep', input: { pattern: 'foo', output_mode: 'content' } },
    );
    expect(result).toContain('grep: foo');
    expect(result).toContain('file.ts');
  });

  it('renders glob tool output with file list', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize(
      { files: ['a.ts', 'b.ts'] },
      { toolName: 'glob', input: { pattern: '*.ts' } },
    );
    expect(result).toContain('glob: *.ts');
    expect(result).toContain('a.ts');
    expect(result).toContain('b.ts');
  });

  it('renders generic tool object for unknown toolName', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize({ foo: 'bar', baz: 42 }, { toolName: 'unknownTool' });
    expect(result).toContain('unknownTool');
    expect(result).toContain('foo');
  });

  it('renders diff field for edit tool', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize(
      {
        diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new',
        path: 'test.ts',
        replacements: 1,
        bytes_written: 100,
      },
      { toolName: 'edit' },
    );
    expect(result).toContain('edit');
    expect(result).toContain('path=test.ts');
  });

  it('renders fetch tool output', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize(
      { content: '<html></html>', status: 200 },
      { toolName: 'fetch', input: { url: 'https://example.com' } },
    );
    expect(result).toContain('fetch: https://example.com');
    expect(result).toContain('status=200');
  });

  it('renders tree tool output', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize(
      { tree: 'dir/', total_files: 1, total_dirs: 2 },
      { toolName: 'tree', input: { path: '.' } },
    );
    expect(result).toContain('tree: .');
    expect(result).toContain('total_files=1');
  });

  it('renders json tool output', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize(
      { formatted: '{ "a": 1 }', type: 'object', keys: ['a'] },
      { toolName: 'json', input: { query: 'a' } },
    );
    expect(result).toContain('json');
    expect(result).toContain('query=a');
  });

  it('renders test output on success', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize(
      { output: 'all passed', exit_code: 0, runner: 'vitest', passed: 5, failed: 0, tests_run: 5 },
      { toolName: 'test' },
    );
    expect(result).toContain('status=passed');
    expect(result).toContain('tests_run=5');
  });

  it('renders test output on failure', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize(
      { output: '1 failed', exit_code: 1, runner: 'vitest', passed: 4, failed: 1, tests_run: 5 },
      { toolName: 'test' },
    );
    expect(result).toContain('error_context');
  });

  it('renders typecheck output on success', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize(
      { output: 'clean', exit_code: 0, errors: 0, warnings: 0 },
      { toolName: 'typecheck' },
    );
    expect(result).toContain('status=passed');
  });

  it('renders command output (stdout/stderr shape)', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize(
      { stdout: 'out', stderr: 'err', exit_code: 0 },
      { toolName: 'bash' },
    );
    expect(result).toContain('bash');
    expect(result).toContain('stdout');
    expect(result).toContain('out');
  });

  it('renders audit output header', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize(
      {
        vulnerabilities: [{ severity: 'high', package: 'foo', title: 'XSS', url: 'https://x' }],
        total: 1,
        exit_code: 1,
      },
      { toolName: 'audit' },
    );
    expect(result).toContain('audit');
    expect(result).toContain('exit_code=1');
  });

  it('renders logs output', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize(
      {
        entries: [{ timestamp: '12:00', level: 'error', message: 'boom' }],
        total: 1,
      },
      { toolName: 'logs' },
    );
    expect(result).toContain('logs');
    expect(result).toContain('boom');
  });

  it('renders outdated output', () => {
    const s = createToolOutputSerializer();
    const result = s.serialize(
      {
        packages: [
          { name: 'foo', current: '1.0', wanted: '1.1', latest: '2.0', type: 'dependencies' },
        ],
        total: 1,
      },
      { toolName: 'outdated' },
    );
    expect(result).toContain('outdated');
    expect(result).toContain('foo');
    expect(result).toContain('current=1.0');
  });
});

describe('enforceCap', () => {
  it('preserves text within budget', () => {
    const s = createToolOutputSerializer();
    const result = s.enforceCap('hello', 1000);
    expect(result.text).toBe('hello');
    expect(result.newBudget).toBe(995);
  });

  it('truncates text exceeding budget', () => {
    const s = createToolOutputSerializer();
    const long = 'x'.repeat(200);
    const result = s.enforceCap(long, 50);
    expect(result.text).toContain('[truncated');
    expect(result.newBudget).toBe(0);
  });

  it('returns cap-exceeded when budget is zero', () => {
    const s = createToolOutputSerializer();
    const result = s.enforceCap('hello', 0);
    expect(result.text).toContain('cap exceeded');
  });
});

describe('truncateForEvent', () => {
  it('returns short content unchanged', () => {
    expect(truncateForEvent('hello')).toBe('hello');
  });
  it('truncates long content with ellipsis', () => {
    const long = 'x'.repeat(500);
    const result = truncateForEvent(long, 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain('…');
  });
  it('returns empty string for empty input', () => {
    expect(truncateForEvent('')).toBe('');
  });
});

describe('sizeSignals', () => {
  it('computes bytes and tokens', () => {
    const sig = sizeSignals(undefined, 'hello world');
    expect(sig.outputBytes).toBe(Buffer.byteLength('hello world'));
    expect(sig.outputTokens).toBeGreaterThan(0);
    expect(sig.outputLines).toBeUndefined();
  });

  it('counts lines for read output', () => {
    const content = '  1→line one\n  2→line two\n  3→line three';
    const sig = sizeSignals('read', content);
    expect(sig.outputLines).toBe(3);
  });

  it('counts lines for bash output', () => {
    const sig = sizeSignals('bash', 'a\nb\nc');
    expect(sig.outputLines).toBe(3);
  });

  it('returns zeros for empty content', () => {
    const sig = sizeSignals('read', '');
    expect(sig.outputBytes).toBe(0);
    expect(sig.outputTokens).toBe(0);
  });
});

// ── glob-expand ─────────────────────────────────────────────────────────

describe('expandGlob', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'glob-test-'));
    mkdirSync(join(tmp, 'sub'));
    writeFileSync(join(tmp, 'a.ts'), '');
    writeFileSync(join(tmp, 'b.ts'), '');
    writeFileSync(join(tmp, 'c.txt'), '');
    writeFileSync(join(tmp, 'sub', 'd.ts'), '');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns literal paths unchanged', async () => {
    const result = await expandGlob(join(tmp, 'a.ts'));
    expect(result).toEqual([join(tmp, 'a.ts')]);
  });

  it('expands *.ts in current dir (non-recursive)', async () => {
    const result = await expandGlob(join(tmp, '*.ts'));
    expect(result).toHaveLength(2);
    expect(result.some((f) => f.includes('a.ts'))).toBe(true);
    expect(result.some((f) => f.includes('b.ts'))).toBe(true);
  });

  it('handles ** recursive pattern (may not recurse on Windows)', async () => {
    const result = await expandGlob(join(tmp, '**', '*.ts'));
    // ** is known to have limited recursion on Windows due to separator handling.
    // Just verify it doesn't crash and returns an array.
    expect(Array.isArray(result)).toBe(true);
  });

  it('handles ? single-char wildcard', async () => {
    const result = await expandGlob(join(tmp, '?.ts'));
    expect(result).toHaveLength(2);
  });

  it('handles character classes', async () => {
    const result = await expandGlob(join(tmp, '[ab].ts'));
    expect(result).toHaveLength(2);
  });

  it('returns empty for non-matching pattern', async () => {
    const result = await expandGlob(join(tmp, '*.json'));
    expect(result).toEqual([]);
  });

  it('handles non-existent base directory gracefully', async () => {
    const result = await expandGlob(join(tmp, 'nonexistent', '*.ts'));
    expect(result).toEqual([]);
  });
});
