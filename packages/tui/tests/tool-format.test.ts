import { describe, expect, it } from 'vitest';
import {
  MULTI_DIFF_SUMMARY_THRESHOLD,
  extractDiffPreview,
  extractMultiFileDiffs,
  extractReplaceDiffs,
  fmtDuration,
  formatMultiDiffSummary,
  formatToolArgs,
  formatToolOutput,
  formatToolVisualOutput,
  summarizeMultiFileDiffs,
} from '../src/components/history.js';

describe('formatToolArgs', () => {
  it('read/edit/write: just the (shortened) path', () => {
    expect(formatToolArgs('read', { path: '/tmp/x.ts' })).toBe('/tmp/x.ts');
    expect(formatToolArgs('edit', { path: '/tmp/x.ts', old_string: 'a', new_string: 'b' })).toBe(
      '/tmp/x.ts',
    );
    expect(formatToolArgs('write', { path: '/tmp/x.ts', content: 'z' })).toBe('/tmp/x.ts');
  });

  it('read with very deep path is shortened with an ellipsis prefix', () => {
    const deep = '/' + 'subdir/'.repeat(20) + 'file.ts';
    const out = formatToolArgs('read', { path: deep });
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('file.ts')).toBe(true);
  });

  it('grep: quoted pattern + optional scope', () => {
    expect(formatToolArgs('grep', { pattern: 'foo' })).toBe('"foo"');
    expect(formatToolArgs('grep', { pattern: 'foo', path: '/src' })).toBe('"foo" in /src');
  });

  it('bash: just the command, truncated', () => {
    expect(formatToolArgs('bash', { command: 'ls -la' })).toBe('ls -la');
    const long = 'echo ' + 'x'.repeat(200);
    const out = formatToolArgs('bash', { command: long });
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('…')).toBe(true);
  });

  it('fetch / webfetch: just the URL', () => {
    expect(formatToolArgs('fetch', { url: 'https://example.com' })).toBe('https://example.com');
  });

  it('todo: item count', () => {
    expect(formatToolArgs('todo', { todos: [{}, {}, {}] })).toBe('3 items');
    expect(formatToolArgs('todo', { todos: [{}] })).toBe('1 item');
  });

  it('work/session/meta tools: concise action summaries', () => {
    expect(formatToolArgs('plan', { action: 'add', title: 'Build better tool UI' })).toBe(
      'add · Build better tool UI',
    );
    expect(formatToolArgs('task', { action: 'status', id: 't1', status: 'completed' })).toBe(
      'status · t1 · completed',
    );
    expect(
      formatToolArgs('remember', {
        scope: 'project-memory',
        type: 'decision',
        text: 'Use pnpm for tests',
      }),
    ).toBe('project-memory · decision · Use pnpm for tests');
    expect(formatToolArgs('search_memory', { query: 'pnpm', scope: 'project-memory' })).toBe(
      '"pnpm" · project-memory',
    );
    expect(formatToolArgs('mode', { action: 'set', mode: 'review' })).toBe('set · review');
  });

  it('catalog/index tools: concise filters', () => {
    expect(formatToolArgs('tool_help', { tool: 'write', format: 'full' })).toBe('write · full');
    expect(
      formatToolArgs('tool_search', { query: 'file', permission: 'auto', mutating: false }),
    ).toBe('"file" · auto · read-only');
    expect(formatToolArgs('tool_use', { tool: 'read' })).toBe('call read');
    expect(
      formatToolArgs('batch_tool_use', {
        calls: [{ tool: 'read' }, { tool: 'grep' }],
        parallel: false,
      }),
    ).toBe('2 calls · sequential');
    expect(
      formatToolArgs('codebase-search', {
        query: 'Agent',
        kind: 'class',
        file: 'packages/core/src',
      }),
    ).toBe('"Agent" · class · in packages/core/src');
    expect(formatToolArgs('codebase-index', { force: true, langs: ['ts', 'tsx'] })).toBe(
      'force · ts,tsx',
    );
    expect(formatToolArgs('set_working_dir', { path: 'packages/tui' })).toBe('packages/tui');
  });

  it('unknown tool: picks the most identifying field', () => {
    expect(formatToolArgs('weird', { name: 'thing', misc: 'noise' })).toBe('thing');
  });

  it('unknown tool with no identifying field: compact JSON preview', () => {
    const out = formatToolArgs('weird', { x: 1, y: 2 });
    expect(out).toContain('"x":1');
  });

  it('returns empty string for missing/non-object input', () => {
    expect(formatToolArgs('read', undefined)).toBe('');
    expect(formatToolArgs('read', null)).toBe('');
    expect(formatToolArgs('read', 'string-input')).toBe('');
  });
});

describe('formatToolOutput', () => {
  it('grep: count from parsed JSON', () => {
    const none = formatToolOutput(
      'grep',
      JSON.stringify({ count: 0, matches: [], truncated: false }),
      true,
    );
    expect(none).toEqual(['no matches']);

    const some = formatToolOutput(
      'grep',
      JSON.stringify({ count: 3, matches: [], truncated: false }),
      true,
    );
    expect(some).toEqual(['3 matches']);

    const trunc = formatToolOutput(
      'grep',
      JSON.stringify({ count: 1, matches: [], truncated: true }),
      true,
    );
    expect(trunc).toHaveLength(1);
    expect(trunc[0]).toContain('1 match');
    expect(trunc[0]).toContain('truncated');
  });

  it('grep: appends a first-match hint when matches are present', () => {
    const out = formatToolOutput(
      'grep',
      JSON.stringify({
        count: 2,
        matches: [{ file: 'src/foo.ts', line: 42, text: 'foo()' }],
        truncated: false,
      }),
      true,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('2 matches');
    expect(out[1]).toContain('src/foo.ts');
    expect(out[1]).toContain('42');
  });

  it('read: surfaces the line range and total count on a single line', () => {
    const text = '   1→hello\n   2→world\n   3→!';
    const out = formatToolOutput('read', text, true);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('L1–3');
    expect(out[0]).toContain('3 lines');
  });

  it('read: single-line read shows just the line number', () => {
    const out = formatToolOutput('read', '  42→only', true);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('L42');
  });

  it('read: non-contiguous numbered lines flag gaps', () => {
    const text = '   1→a\n   2→b\n  50→c';
    const out = formatToolOutput('read', text, true);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('L1–50');
    expect(out[0]).toContain('gaps');
  });

  it('edit: surfaces replacement count from JSON', () => {
    expect(formatToolOutput('edit', JSON.stringify({ replacements: 2, path: '/x' }), true)).toEqual(
      ['2 replacements'],
    );
    expect(formatToolOutput('edit', JSON.stringify({ replacements: 1, path: '/x' }), true)).toEqual(
      ['1 replacement'],
    );
  });

  it('write: bytes written', () => {
    const out = formatToolOutput('write', JSON.stringify({ bytes: 1024, path: '/x' }), true);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('1.0KB');
  });

  it('bash: 2 lines when stdout has content (header + preview)', () => {
    const out = formatToolOutput(
      'bash',
      JSON.stringify({ exit_code: 0, stdout: 'first line\nsecond\nthird' }),
      true,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('exit 0');
    expect(out[0]).toContain('3 out');
    expect(out[1]).toContain('first line');
  });

  it('bash: 3 lines when both stdout and stderr have content', () => {
    const out = formatToolOutput(
      'bash',
      JSON.stringify({
        exit_code: 0,
        stdout: 'normal output',
        stderr: 'a warning happened',
      }),
      true,
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('1 out');
    expect(out[0]).toContain('1 err');
    expect(out[1]).toContain('normal output');
    expect(out[2]).toMatch(/^! /);
    expect(out[2]).toContain('warning');
  });

  it('bash: 1 line when only exit code is known', () => {
    const out = formatToolOutput(
      'bash',
      JSON.stringify({ exit_code: 0, stdout: '', stderr: '' }),
      true,
    );
    expect(out).toEqual(['exit 0']);
  });

  it('bash: stderr-only shows a single preview line marked with !', () => {
    const out = formatToolOutput(
      'bash',
      JSON.stringify({ exit_code: 1, stdout: '', stderr: 'boom' }),
      true,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('exit 1');
    expect(out[0]).toContain('1 err');
    expect(out[1]).toContain('boom');
  });
  it('bash: timed_out=true adds a "timed out" chip alongside exit/line counts', () => {
    const out = formatToolOutput(
      'bash',
      JSON.stringify({ exit_code: 124, stdout: 'partial\noutput', stderr: '', timed_out: true }),
      true,
    );

    expect(out[0]).toContain('exit 124');
    expect(out[0]).toContain('timed out');
    expect(out[0]).toContain('2 out');
    expect(out[1]).toContain('partial');
  });
  it('bash: output/error aliases render line counts and timeout metadata', () => {
    const out = formatToolOutput(
      'bash',
      JSON.stringify({
        exitCode: 124,
        output: 'partial\noutput',
        error: 'late warning',
        timedOut: true,
      }),
      true,
    );

    expect(out).toHaveLength(3);
    expect(out[0]).toContain('exit 124');
    expect(out[0]).toContain('timed out');
    expect(out[0]).toContain('2 out');
    expect(out[0]).toContain('1 err');
    expect(out[1]).toContain('partial');
    expect(out[2]).toMatch(/^! /);
    expect(out[2]).toContain('late warning');
  });
  it('bash: exit_code: null is treated as "no exit" — only the line counts render', () => {
    // Some bash failure paths (e.g. spawn ENOENT) yield exit_code: null.
    // The branch must not print "exit null" or "exit undefined"; it
    // simply skips the exit slot and lets the preview line stand alone.
    const out = formatToolOutput(
      'bash',
      JSON.stringify({ exit_code: null, stdout: '', stderr: 'spawn failed' }),
      true,
    );
    expect(out[0]).not.toContain('exit');
    expect(out[0]).toContain('1 err');
    expect(out[1]).toContain('spawn failed');
  });
  it('bash: stdout + stderr preview dedup — identical first line collapses to a single entry', () => {
    // firstNonEmpty returns the same string for both; without the
    // stderr-preview-dedup check the renderer would print the same line
    // twice (once plain, once `!`-prefixed).
    const out = formatToolOutput(
      'bash',
      JSON.stringify({ exit_code: 0, stdout: 'shared line\nmore', stderr: 'shared line' }),
      true,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('2 out');
    expect(out[0]).toContain('1 err');
    expect(out[1]).toContain('shared line');
  });

  // exec (heuristic danger detection, PR 5 — TUI render)

  it('exec (destructive): renders a DESTRUCTIVE chip + first reason + exit/line counts + preview', () => {
    const out = formatToolOutput(
      'exec',
      JSON.stringify({
        exit_code: 0,
        stdout: 'removed ./build',
        stderr: '',
        danger: {
          level: 'destructive',
          reasons: ['recursive force-delete'],
          matchedRule: 'rm-recursive',
        },
      }),
      true,
    );
    expect(out[0]).toContain('⚠ DESTRUCTIVE');
    expect(out[0]).toContain('recursive force-delete');
    expect(out[0]).toContain('exit 0');
    expect(out[0]).toContain('1 out');
    // stdout preview is on its own line
    expect(out.find((l) => l.includes('removed ./build'))).toBeDefined();
  });

  it('exec (caution): renders a CAUTION chip + first reason', () => {
    const out = formatToolOutput(
      'exec',
      JSON.stringify({
        exit_code: 0,
        stdout: '',
        stderr: '',
        danger: { level: 'caution', reasons: ['inline script evaluation (-c / -e / --eval)'] },
      }),
      true,
    );
    expect(out[0]).toContain('! CAUTION');
    expect(out[0]).toContain('inline script evaluation');
    expect(out[0]).toContain('exit 0');
  });

  it('exec (multi-rule): stacks additional reasons below the first', () => {
    const out = formatToolOutput(
      'exec',
      JSON.stringify({
        exit_code: 0,
        stdout: '',
        stderr: '',
        danger: {
          level: 'destructive',
          reasons: ['recursive force-delete', 'privilege escalation (sudo / doas)'],
        },
      }),
      true,
    );
    expect(out[0]).toContain('recursive force-delete');
    // Second reason appears on a separate stacked line.
    const stacked = out.find((l) => l.includes('privilege escalation'));
    expect(stacked).toBeDefined();
    expect(stacked).toMatch(/^\s+·/); // indent + bullet
  });

  it('exec (safe): no chip — falls through to the bash-style line', () => {
    const out = formatToolOutput(
      'exec',
      JSON.stringify({
        exit_code: 0,
        stdout: 'On branch main',
        stderr: '',
        danger: { level: 'safe', reasons: [] },
      }),
      true,
    );
    // Safe level produces no DESTRUCTIVE / CAUTION chip in the first line.
    expect(out[0]).not.toContain('DESTRUCTIVE');
    expect(out[0]).not.toContain('CAUTION');
    expect(out[0]).toContain('exit 0');
  });

  it('exec (no danger field): behaves like safe (backward compat with pre-PR-1 output)', () => {
    const out = formatToolOutput(
      'exec',
      JSON.stringify({ exit_code: 0, stdout: 'ok', stderr: '' }),
      true,
    );
    expect(out[0]).not.toContain('DESTRUCTIVE');
    expect(out[0]).not.toContain('CAUTION');
    expect(out[0]).toContain('exit 0');
  });

  it('exec (destructive, with stderr): still surfaces the chip and the stderr preview', () => {
    const out = formatToolOutput(
      'exec',
      JSON.stringify({
        exit_code: 1,
        stdout: '',
        stderr: 'permission denied',
        danger: { level: 'destructive', reasons: ['recursive force-delete'] },
      }),
      true,
    );
    expect(out[0]).toContain('⚠ DESTRUCTIVE');
    expect(out[0]).toContain('exit 1');
    expect(out[0]).toContain('1 err');
    const stderrLine = out.find((l) => l.startsWith('!'));
    expect(stderrLine).toContain('permission denied');
  });

  it('todo: no extra line on success (item count is already in args)', () => {
    expect(formatToolOutput('todo', 'updated', true)).toEqual([]);
  });

  it('unknown tool: all whitespace collapsed to single line', () => {
    // The fallback used to take only the first non-empty line, which
    // broke pretty-printed JSON results (the first line was just `{`).
    // The new behavior joins every line with single spaces so the
    // preview surfaces the actual content, not just the opening brace.
    expect(formatToolOutput('weird', '\n\nfirst line\nsecond line', true)).toEqual([
      'first line second line',
    ]);
  });

  it('unknown tool: JSON object rendered as key=value preview', () => {
    // Pretty-printed JSON used to display as `└─ {` (just the opening
    // brace from the first line). The new behavior summarizes by key.
    const json = JSON.stringify(
      { ok: false, stopReason: 'host_timeout', error: 'too slow', toolCalls: 12 },
      null,
      2,
    );
    const out = formatToolOutput('delegate', json, false);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('ok=false');
    expect(out[0]).toContain('stopReason="host_timeout"');
    expect(out[0]).toContain('error="too slow"');
    expect(out[0]).toContain('toolCalls=12');
  });

  it('failed tool with empty output renders ["failed"]', () => {
    expect(formatToolOutput('weird', undefined, false)).toEqual(['failed']);
    expect(formatToolOutput('weird', '', false)).toEqual(['failed']);
  });

  it('successful tool with empty output renders []', () => {
    expect(formatToolOutput('weird', '', true)).toEqual([]);
  });
});

describe('formatToolOutput (extended tools)', () => {
  it('write: reports created vs updated with bytes', () => {
    expect(
      formatToolOutput('write', JSON.stringify({ bytes_written: 1024, created: true }), true),
    ).toEqual(['created · 1.0KB']);
    expect(
      formatToolOutput('write', JSON.stringify({ bytes_written: 512, created: false }), true),
    ).toEqual(['updated · 512B']);
  });

  it('patch: applied / rejected + first file', () => {
    const out = formatToolOutput(
      'patch',
      JSON.stringify({ applied: 2, rejected: 1, files: ['src/a.ts', 'src/b.ts'] }),
      true,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('2 applied');
    expect(out[0]).toContain('1 rejected');
    expect(out[1]).toContain('src/a.ts');
    expect(out[1]).toContain('+1');
  });

  it('test: passed/failed/duration summary', () => {
    const out = formatToolOutput(
      'test',
      JSON.stringify({
        runner: 'vitest',
        exit_code: 0,
        tests_run: 10,
        passed: 9,
        failed: 1,
        duration_ms: 4200,
      }),
      true,
    );
    expect(out).toEqual(['vitest · 9/10 passed · 1 failed · 4.2s']);
  });

  it('lint: errors + warnings + linter', () => {
    const out = formatToolOutput(
      'lint',
      JSON.stringify({ linter: 'biome', files_checked: 12, errors: 2, warnings: 5 }),
      true,
    );
    expect(out[0]).toContain('biome');
    expect(out[0]).toContain('2 errors');
    expect(out[0]).toContain('5 warnings');
    expect(out[0]).toContain('12 files');
  });

  it('fetch: HTTP status + content type + size', () => {
    const out = formatToolOutput(
      'fetch',
      JSON.stringify({
        status: 200,
        content_type: 'text/html',
        url: 'https://x',
        content: 'a'.repeat(2048),
      }),
      true,
    );
    expect(out[0]).toContain('HTTP 200');
    expect(out[0]).toContain('text/html');
    expect(out[0]).toContain('2.0KB');
  });

  it('tree: files + dirs counts', () => {
    expect(
      formatToolOutput(
        'tree',
        JSON.stringify({ total_files: 42, total_dirs: 7, tree: 'x', truncated: false, path: '.' }),
        true,
      ),
    ).toEqual(['42 files · 7 dirs']);
  });

  it('audit: zero-vuln short-circuits', () => {
    expect(
      formatToolOutput(
        'audit',
        JSON.stringify({
          exit_code: 0,
          vulnerabilities: [],
          total: 0,
          summary: 'No vulnerabilities found',
        }),
        true,
      ),
    ).toEqual(['no vulnerabilities']);
  });

  it('outdated: surfaces first package upgrade', () => {
    const out = formatToolOutput(
      'outdated',
      JSON.stringify({
        exit_code: 1,
        total: 3,
        packages: [{ name: 'foo', current: '1.0.0', wanted: '1.2.0' }],
      }),
      true,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('3 outdated');
    expect(out[1]).toContain('foo: 1.0.0 → 1.2.0');
  });
});

describe('extractDiffPreview', () => {
  const sampleDiff = [
    'diff --git a/x.ts b/x.ts',
    'index abc..def 100644',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,3 +1,3 @@',
    ' unchanged',
    '-removed line',
    '+added line',
    ' another',
  ].join('\n');

  it('returns undefined when tool has no diff field', () => {
    expect(extractDiffPreview('bash', JSON.stringify({ exit_code: 0 }))).toBeUndefined();
    expect(extractDiffPreview('read', '  1→hello')).toBeUndefined();
    expect(extractDiffPreview('edit', undefined)).toBeUndefined();
  });

  it('parses an edit-tool diff JSON into add/del/hunk rows', () => {
    const out = extractDiffPreview(
      'edit',
      JSON.stringify({ path: '/x', replacements: 1, diff: sampleDiff }),
    );
    expect(out).toBeDefined();
    const kinds = out!.rows.map((r) => r.kind);
    expect(kinds).toContain('hunk');
    expect(kinds).toContain('add');
    expect(kinds).toContain('del');
    expect(kinds).toContain('ctx');
    // header lines (diff --git, index, ---, +++) are stripped.
    expect(out!.rows.some((r) => r.text.startsWith('---'))).toBe(false);
    expect(out!.rows.some((r) => r.text.startsWith('+++'))).toBe(false);
  });

  it('parses the serializer plain-text form (header line + raw diff, not JSON)', () => {
    // This is exactly what the tool-output serializer emits for an edit:
    // a human-readable header line followed by the raw unified diff — NOT
    // JSON. Before the fix this fell through to a flat plain-text view.
    const serialized = ['edit (path=/x replacements=1)', sampleDiff].join('\n');
    const out = extractDiffPreview('edit', serialized);
    expect(out).toBeDefined();
    const kinds = out!.rows.map((r) => r.kind);
    expect(kinds).toContain('hunk');
    expect(kinds).toContain('add');
    expect(kinds).toContain('del');
    expect(kinds).toContain('ctx');
    expect(out!.added).toBe(1);
    expect(out!.removed).toBe(1);
    // The `edit (...)` header line must NOT leak in as a context row.
    expect(out!.rows.some((r) => r.text.includes('replacements='))).toBe(false);
  });

  it('parses a serializer diff with no `---` header, only @@ hunks', () => {
    const serialized = [
      'edit (path=/x replacements=2)',
      '@@ -1,2 +1,2 @@',
      ' ctx',
      '-gone',
      '+here',
    ].join('\n');
    const out = extractDiffPreview('edit', serialized);
    expect(out).toBeDefined();
    expect(out!.added).toBe(1);
    expect(out!.removed).toBe(1);
    expect(out!.rows.some((r) => r.text.includes('replacements='))).toBe(false);
  });

  it('caps long previews and reports the hidden remainder with add/remove stats', () => {
    const many = ['@@ -1,20 +1,20 @@', ...Array.from({ length: 30 }, (_, i) => `+line ${i}`)].join(
      '\n',
    );
    const out = extractDiffPreview('edit', JSON.stringify({ diff: many }));
    expect(out!.rows.length).toBeLessThan(31);
    expect(out!.rows.length + out!.hidden).toBe(31);
    expect(out!.hidden).toBeGreaterThan(0);
    expect(out!.added).toBe(30);
    expect(out!.hiddenAdded).toBeGreaterThan(0);
  });

  it('skips no-op edit sentinel diff', () => {
    const out = extractDiffPreview(
      'edit',
      JSON.stringify({ diff: '(no-op: old and new are identical)' }),
    );
    expect(out).toBeUndefined();
  });

  it('parses raw unified diff for patch tool (no JSON wrapper)', () => {
    const out = extractDiffPreview('patch', sampleDiff);
    expect(out).toBeDefined();
    expect(out!.rows.some((r) => r.kind === 'add')).toBe(true);
    expect(out!.rows.some((r) => r.kind === 'del')).toBe(true);
  });

  it('parses write-tool diff JSON for existing-file overwrites', () => {
    const out = extractDiffPreview(
      'write',
      JSON.stringify({ path: '/x', created: false, diff: sampleDiff }),
    );
    expect(out).toBeDefined();
    expect(out!.rows.some((r) => r.kind === 'add')).toBe(true);
    expect(out!.rows.some((r) => r.kind === 'del')).toBe(true);
  });

  it('builds a compact added-line preview for newly written files', () => {
    const out = extractDiffPreview(
      'write',
      JSON.stringify({ path: 'src/new.ts', created: true, diff: '+++ src/new.ts\n+ (new file)' }),
      { path: 'src/new.ts', content: 'one\ntwo\nthree' },
    );
    expect(out).toBeDefined();
    expect(out!.removed).toBe(0);
    expect(out!.added).toBe(3);
    expect(out!.rows.filter((r) => r.kind === 'add').map((r) => [r.newLine, r.text])).toEqual([
      [1, '+one'],
      [2, '+two'],
      [3, '+three'],
    ]);
  });

  it('collects nested diffs from replace-tool results', () => {
    const out = extractDiffPreview(
      'replace',
      JSON.stringify({
        results: [
          { path: 'src/a.ts', replacements: 1, diff: sampleDiff },
          { path: 'src/unchanged.ts', replacements: 0 },
        ],
      }),
    );
    expect(out).toBeDefined();
    expect(out!.rows.some((r) => r.kind === 'add')).toBe(true);
    expect(out!.rows.some((r) => r.kind === 'del')).toBe(true);
  });

  it('attaches old/new line numbers from the @@ hunk header', () => {
    const diff = ['@@ -10,3 +20,3 @@', ' ctx-a', '-removed', '+added', ' ctx-b'].join('\n');
    const out = extractDiffPreview('patch', diff);
    expect(out).toBeDefined();
    const rows = out!.rows;
    const ctxA = rows.find((r) => r.kind === 'ctx' && r.text.includes('ctx-a'))!;
    const del = rows.find((r) => r.kind === 'del')!;
    const add = rows.find((r) => r.kind === 'add')!;
    const ctxB = rows.find((r) => r.kind === 'ctx' && r.text.includes('ctx-b'))!;
    expect(ctxA.oldLine).toBe(10);
    expect(ctxA.newLine).toBe(20);
    // del advances only the old-file counter; add advances only the new one.
    expect(del.oldLine).toBe(11);
    expect(add.newLine).toBe(21);
    // After one ctx + one del + one add, both counters should be at 12 / 22.
    expect(ctxB.oldLine).toBe(12);
    expect(ctxB.newLine).toBe(22);
  });
});

describe('extractReplaceDiffs', () => {
  const sampleDiffA = ['@@ -1,2 +1,2 @@', '-old a', '+new a'].join('\n');
  const sampleDiffB = ['@@ -1,2 +1,2 @@', '-old b', '+new b'].join('\n');

  it('returns one DiffFilePreview per file when results carry per-path diffs', () => {
    const out = extractReplaceDiffs(
      'replace',
      JSON.stringify({
        results: [
          { path: 'src/a.ts', replacements: 1, diff: sampleDiffA },
          { path: 'src/b.ts', replacements: 1, diff: sampleDiffB },
        ],
      }),
    );
    expect(out).toBeDefined();
    expect(out!).toHaveLength(2);
    expect(out![0]!.path).toBe('src/a.ts');
    expect(out![1]!.path).toBe('src/b.ts');
    expect(out![0]!.preview.added).toBe(1);
    expect(out![1]!.preview.removed).toBe(1);
  });

  it('caps each per-file preview independently and reports hidden stats', () => {
    const longDiff = [
      '@@ -1,30 +1,30 @@',
      ...Array.from({ length: 30 }, (_, i) => `+line ${i}`),
    ].join('\n');
    const out = extractReplaceDiffs(
      'replace',
      JSON.stringify({
        results: [{ path: 'src/big.ts', replacements: 1, diff: longDiff }],
      }),
    );
    expect(out).toBeDefined();
    expect(out![0]!.preview.added).toBe(30);
    expect(out![0]!.preview.hiddenAdded).toBeGreaterThan(0);
    expect(out![0]!.preview.rows.length).toBeLessThan(31);
  });

  it('skips results without a diff field (e.g. unchanged files)', () => {
    const out = extractReplaceDiffs(
      'replace',
      JSON.stringify({
        results: [
          { path: 'src/a.ts', replacements: 1, diff: sampleDiffA },
          { path: 'src/unchanged.ts', replacements: 0 },
          { path: 'src/b.ts', replacements: 1, diff: sampleDiffB },
        ],
      }),
    );
    expect(out).toBeDefined();
    expect(out!.map((item) => item.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('falls back to the input path when a result omits its own path', () => {
    const out = extractReplaceDiffs(
      'replace',
      JSON.stringify({
        results: [{ replacements: 1, diff: sampleDiffA }],
      }),
      { path: 'src/fallback.ts' },
    );
    expect(out).toBeDefined();
    expect(out![0]!.path).toBe('src/fallback.ts');
  });

  it('returns undefined for non-replace tools', () => {
    expect(extractReplaceDiffs('edit', JSON.stringify({ diff: sampleDiffA }))).toBeUndefined();
    expect(extractReplaceDiffs('patch', sampleDiffA)).toBeUndefined();
  });

  it('returns undefined when output is missing, empty, or not parseable', () => {
    expect(extractReplaceDiffs('replace', undefined)).toBeUndefined();
    expect(extractReplaceDiffs('replace', '')).toBeUndefined();
    expect(extractReplaceDiffs('replace', 'not json')).toBeUndefined();
    expect(extractReplaceDiffs('replace', JSON.stringify({ results: [] }))).toBeUndefined();
  });

  it('falls back to "unknown file" when neither result path nor input path is available', () => {
    const out = extractReplaceDiffs(
      'replace',
      JSON.stringify({ results: [{ replacements: 1, diff: sampleDiffA }] }),
    );
    expect(out).toBeDefined();
    expect(out![0]!.path).toBe('unknown file');
  });
});

describe('extractMultiFileDiffs', () => {
  const gitStyleMultiDiff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    '-old a',
    '+new a',
    'diff --git a/src/b.ts b/src/b.ts',
    'index 333..444 100644',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1,2 +1,2 @@',
    '-old b',
    '+new b',
  ].join('\n');

  describe('diff tool (git diff output)', () => {
    it('splits a multi-file git-style diff into one block per file', () => {
      const out = extractMultiFileDiffs(
        'diff',
        JSON.stringify({ diff: gitStyleMultiDiff, files: [], truncated: false, mode: 'unified' }),
      );
      expect(out).toBeDefined();
      expect(out!.map((item) => item.path)).toEqual(['src/a.ts', 'src/b.ts']);
      expect(out!.every((item) => item.preview.rows.some((r) => r.kind === 'add'))).toBe(true);
      expect(out!.every((item) => item.preview.rows.some((r) => r.kind === 'del'))).toBe(true);
    });

    it('pairs the explicit `files` array with diff blocks left-to-right', () => {
      const out = extractMultiFileDiffs(
        'diff',
        JSON.stringify({
          diff: gitStyleMultiDiff,
          files: ['custom/a.ts', 'custom/b.ts'],
          truncated: false,
          mode: 'unified',
        }),
      );
      expect(out).toBeDefined();
      expect(out!.map((item) => item.path)).toEqual(['custom/a.ts', 'custom/b.ts']);
    });

    it('falls back to parsed header paths when `files` is shorter than the diff', () => {
      // Single-file diff but the JSON says `files: []` — should still
      // resolve a path from the `diff --git` header.
      const out = extractMultiFileDiffs(
        'diff',
        JSON.stringify({
          diff: gitStyleMultiDiff.split('\ndiff --git a/src/b.ts')[0]!,
          files: [],
          truncated: false,
          mode: 'unified',
        }),
      );
      expect(out).toBeDefined();
      expect(out![0]!.path).toBe('src/a.ts');
    });

    it('returns undefined for diff output without a diff body', () => {
      expect(
        extractMultiFileDiffs('diff', JSON.stringify({ files: [], diff: '' })),
      ).toBeUndefined();
    });

    it('handles paths with spaces via the lastIndexOf b/ fallback', () => {
      const weirdDiff = [
        'diff --git a/path with spaces/x.ts b/path with spaces/x.ts',
        '--- a/path with spaces/x.ts',
        '+++ b/path with spaces/x.ts',
        '@@ -1,1 +1,1 @@',
        '-old',
        '+new',
      ].join('\n');
      const out = extractMultiFileDiffs('diff', JSON.stringify({ diff: weirdDiff, files: [] }));
      expect(out).toBeDefined();
      expect(out![0]!.path).toBe('path with spaces/x.ts');
    });
  });

  describe('patch tool', () => {
    it('splits a multi-file patch from JSON { diff, files }', () => {
      const out = extractMultiFileDiffs(
        'patch',
        JSON.stringify({
          applied: 2,
          rejected: 0,
          files: ['src/a.ts', 'src/b.ts'],
          diff: gitStyleMultiDiff,
        }),
      );
      expect(out).toBeDefined();
      expect(out!.map((item) => item.path)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('handles a single-file patch with `--- /+++` but no `diff --git`', () => {
      const singleFile = [
        '--- a/src/only.ts',
        '+++ b/src/only.ts',
        '@@ -1,1 +1,1 @@',
        '-old',
        '+new',
      ].join('\n');
      const out = extractMultiFileDiffs(
        'patch',
        JSON.stringify({ applied: 1, files: ['src/only.ts'], diff: singleFile }),
      );
      expect(out).toBeDefined();
      expect(out).toHaveLength(1);
      expect(out![0]!.path).toBe('src/only.ts');
    });

    it('parses a raw unified diff (no JSON wrapper)', () => {
      const out = extractMultiFileDiffs('patch', gitStyleMultiDiff);
      expect(out).toBeDefined();
      expect(out!.map((item) => item.path)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('returns undefined for a patch result with no diff and no @@ lines', () => {
      expect(
        extractMultiFileDiffs('patch', JSON.stringify({ applied: 0, files: [], message: 'no-op' })),
      ).toBeUndefined();
    });
  });

  describe('tool gating', () => {
    it('returns undefined for tools that are not multi-file diff producers', () => {
      expect(extractMultiFileDiffs('edit', JSON.stringify({ diff: 'something' }))).toBeUndefined();
      expect(extractMultiFileDiffs('write', JSON.stringify({ diff: 'something' }))).toBeUndefined();
      expect(extractMultiFileDiffs('bash', 'some stdout')).toBeUndefined();
      expect(extractMultiFileDiffs('grep', 'matches')).toBeUndefined();
    });

    it('returns undefined for missing or empty output', () => {
      expect(extractMultiFileDiffs('diff', undefined)).toBeUndefined();
      expect(extractMultiFileDiffs('diff', '')).toBeUndefined();
      expect(extractMultiFileDiffs('patch', undefined)).toBeUndefined();
    });

    it('returns undefined for a diff output that is JSON but has no diff body', () => {
      expect(
        extractMultiFileDiffs(
          'diff',
          JSON.stringify({ files: [], mode: 'unified', truncated: false }),
        ),
      ).toBeUndefined();
    });
  });

  describe('caps and per-file isolation', () => {
    it('caps each per-file preview independently under a multi-file diff', () => {
      const longA = [
        'diff --git a/big.ts b/big.ts',
        '--- a/big.ts',
        '+++ b/big.ts',
        '@@ -1,30 +1,30 @@',
        ...Array.from({ length: 30 }, (_, i) => `+line ${i}`),
      ].join('\n');
      const longB = [
        'diff --git a/bigger.ts b/bigger.ts',
        '--- a/bigger.ts',
        '+++ b/bigger.ts',
        '@@ -1,40 +1,40 @@',
        ...Array.from({ length: 40 }, (_, i) => `-drop ${i}`),
      ].join('\n');
      const out = extractMultiFileDiffs(
        'diff',
        JSON.stringify({ diff: `${longA}\n${longB}`, files: [] }),
      );
      expect(out).toBeDefined();
      expect(out![0]!.preview.added).toBe(30);
      expect(out![1]!.preview.removed).toBe(40);
      // Both previews are independently capped below their raw counts.
      expect(out![0]!.preview.rows.length).toBeLessThan(31);
      expect(out![1]!.preview.rows.length).toBeLessThan(41);
    });
  });

  describe('multi-file summary footer', () => {
    // Helper: build a DiffFilePreview with custom counts.
    const preview = (
      path: string,
      added: number,
      removed: number,
      hidden = 0,
      hiddenAdded = 0,
      hiddenRemoved = 0,
    ) => ({
      path,
      preview: {
        rows: [],
        hidden,
        added,
        removed,
        hiddenAdded,
        hiddenRemoved,
      },
    });

    it('aggregates totals across the supplied files', () => {
      const summary = summarizeMultiFileDiffs([
        preview('src/a.ts', 10, 2),
        preview('src/b.ts', 5, 3),
        preview('src/c.ts', 0, 1),
      ]);
      expect(summary.fileCount).toBe(3);
      expect(summary.added).toBe(15);
      expect(summary.removed).toBe(6);
      expect(summary.truncatedFiles).toBe(0);
    });

    it('counts truncated files based on `hidden > 0`', () => {
      const summary = summarizeMultiFileDiffs([
        preview('src/a.ts', 100, 0, 50, 50, 0),
        preview('src/b.ts', 100, 0, 0, 0, 0),
        preview('src/c.ts', 100, 0, 20, 20, 0),
      ]);
      expect(summary.truncatedFiles).toBe(2);
      expect(summary.hiddenAdded).toBe(70);
    });

    it('returns null when below the threshold so the per-file footer carries the signal', () => {
      const summary = summarizeMultiFileDiffs(
        Array.from({ length: MULTI_DIFF_SUMMARY_THRESHOLD - 1 }, (_, i) =>
          preview(`src/file-${i}.ts`, 1, 0),
        ),
      );
      expect(summary.fileCount).toBe(MULTI_DIFF_SUMMARY_THRESHOLD - 1);
      expect(formatMultiDiffSummary(summary)).toBeNull();
    });

    it('renders a single dim italic-style line at or above the threshold', () => {
      const summary = summarizeMultiFileDiffs(
        Array.from({ length: MULTI_DIFF_SUMMARY_THRESHOLD }, (_, i) =>
          preview(`src/file-${i}.ts`, 2, 1),
        ),
      );
      const line = formatMultiDiffSummary(summary);
      expect(line).not.toBeNull();
      expect(line).toContain(`${MULTI_DIFF_SUMMARY_THRESHOLD} files`);
      expect(line).toContain(`+${2 * MULTI_DIFF_SUMMARY_THRESHOLD}`);
      expect(line).toContain(`-${MULTI_DIFF_SUMMARY_THRESHOLD}`);
      // No hidden rows in this fixture → no `… +N -M hidden across` clause.
      expect(line).not.toContain('hidden across');
    });

    it('appends a hidden-rows clause when any file was truncated', () => {
      const summary = summarizeMultiFileDiffs([
        preview('src/a.ts', 100, 0, 50, 50, 0),
        preview('src/b.ts', 100, 0, 0, 0, 0),
        preview('src/c.ts', 100, 0, 20, 20, 0),
        preview('src/d.ts', 100, 0, 10, 0, 10),
        preview('src/e.ts', 100, 0, 0, 0, 0),
      ]);
      const line = formatMultiDiffSummary(summary);
      expect(line).not.toBeNull();
      expect(line).toContain('… +70 -10 hidden across 3 files');
    });

    it('uses singular "file" when only one file was truncated', () => {
      const summary = summarizeMultiFileDiffs([
        preview('src/a.ts', 100, 0, 5, 5, 0),
        preview('src/b.ts', 0, 0, 0, 0, 0),
        preview('src/c.ts', 0, 0, 0, 0, 0),
        preview('src/d.ts', 0, 0, 0, 0, 0),
        preview('src/e.ts', 0, 0, 0, 0, 0),
      ]);
      const line = formatMultiDiffSummary(summary);
      expect(line).toContain('hidden across 1 file');
      expect(line).not.toContain('hidden across 1 files');
    });

    it('omits add/remove segments when both are zero', () => {
      const summary = summarizeMultiFileDiffs(
        Array.from({ length: MULTI_DIFF_SUMMARY_THRESHOLD }, (_, i) =>
          preview(`src/file-${i}.ts`, 0, 0),
        ),
      );
      const line = formatMultiDiffSummary(summary);
      expect(line).not.toBeNull();
      expect(line).toBe(`${MULTI_DIFF_SUMMARY_THRESHOLD} files`);
    });

    it('handles 5+ files end-to-end via extractMultiFileDiffs + summarizer', () => {
      // Build a real 5-file git diff and confirm the summary aggregates
      // what the extractor produces — guards against drift between the
      // extractor's count fields and the summarizer's expectations.
      const blocks = Array.from({ length: 5 }, (_, i) => {
        const path = `src/file-${i}.ts`;
        return [
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          '@@ -1,3 +1,3 @@',
          `-old-${i}-a`,
          `-old-${i}-b`,
          `+new-${i}-a`,
          `+new-${i}-b`,
        ].join('\n');
      }).join('\n');
      const out = extractMultiFileDiffs('diff', JSON.stringify({ diff: blocks, files: [] }));
      expect(out).toBeDefined();
      expect(out!.length).toBe(5);
      const summary = summarizeMultiFileDiffs(out!);
      const line = formatMultiDiffSummary(summary);
      expect(line).toContain('5 files');
      expect(line).toContain('+10'); // 2 added per file × 5
      expect(line).toContain('-10'); // 2 removed per file × 5
    });
  });

  describe('user-tunable threshold', () => {
    const preview = (path: string, added: number, removed: number) => ({
      path,
      preview: { rows: [], hidden: 0, added, removed, hiddenAdded: 0, hiddenRemoved: 0 },
    });

    it('threshold=3 renders the footer at 3+ files (lower than the default 5)', () => {
      const items = [
        preview('src/a.ts', 1, 0),
        preview('src/b.ts', 1, 0),
        preview('src/c.ts', 1, 0),
      ];
      const summary = summarizeMultiFileDiffs(items);
      expect(formatMultiDiffSummary(summary, MULTI_DIFF_SUMMARY_THRESHOLD)).toBeNull();
      expect(formatMultiDiffSummary(summary, 3)).not.toBeNull();
      expect(formatMultiDiffSummary(summary, 3)).toContain('3 files');
    });

    it('threshold=10 keeps the footer suppressed at 5 files', () => {
      const items = Array.from({ length: 5 }, (_, i) => preview(`src/f${i}.ts`, 1, 0));
      const summary = summarizeMultiFileDiffs(items);
      expect(formatMultiDiffSummary(summary, 10)).toBeNull();
    });

    it('threshold=0 suppresses the summary entirely', () => {
      const items = Array.from({ length: 50 }, (_, i) => preview(`src/f${i}.ts`, 1, 0));
      const summary = summarizeMultiFileDiffs(items);
      expect(formatMultiDiffSummary(summary, 0)).toBeNull();
    });

    it('negative threshold falls back to the default (so undefined-coerced values work)', () => {
      const items = Array.from({ length: MULTI_DIFF_SUMMARY_THRESHOLD }, (_, i) =>
        preview(`src/f${i}.ts`, 1, 0),
      );
      const summary = summarizeMultiFileDiffs(items);
      // Passing -1 is the documented "use default" sentinel.
      const defaulted = formatMultiDiffSummary(summary, -1);
      const explicit = formatMultiDiffSummary(summary, MULTI_DIFF_SUMMARY_THRESHOLD);
      expect(defaulted).toBe(explicit);
      expect(defaulted).not.toBeNull();
    });

    it('omitting the threshold argument uses the default', () => {
      const items = Array.from({ length: MULTI_DIFF_SUMMARY_THRESHOLD }, (_, i) =>
        preview(`src/f${i}.ts`, 1, 0),
      );
      const summary = summarizeMultiFileDiffs(items);
      // No second argument — should match the default behavior.
      expect(formatMultiDiffSummary(summary)).toBe(
        formatMultiDiffSummary(summary, MULTI_DIFF_SUMMARY_THRESHOLD),
      );
    });

    it('threshold=2 produces a footer at exactly 2 files', () => {
      const items = [preview('src/a.ts', 1, 0), preview('src/b.ts', 0, 1)];
      const summary = summarizeMultiFileDiffs(items);
      const line = formatMultiDiffSummary(summary, 2);
      expect(line).not.toBeNull();
      expect(line).toContain('2 files');
      expect(line).toContain('+1');
      expect(line).toContain('-1');
    });
  });
});

describe('formatToolVisualOutput', () => {
  it('renders read serializer output as numbered code rows', () => {
    const out = formatToolVisualOutput(
      'read',
      ['read: src/a.ts (total_lines=3)', '1→const a = 1;', '2→const b = 2;'].join('\n'),
      true,
    );
    expect(out).toEqual([
      { kind: 'code', lineNo: '1', text: 'const a = 1;' },
      { kind: 'code', lineNo: '2', text: 'const b = 2;' },
    ]);
  });

  it('renders grep grouped serializer output with file and match rows', () => {
    const out = formatToolVisualOutput(
      'grep',
      [
        'grep: widget (count=2 shown=2)',
        'src/a.ts (2 match(es), showing 2)',
        '10:const widget = true;',
        '12:render(widget);',
      ].join('\n'),
      true,
    );
    expect(out?.[0]).toMatchObject({ kind: 'path', path: 'src/a.ts', text: '2 match(es)' });
    expect(out?.[1]).toMatchObject({ kind: 'match', path: 'src/a.ts', lineNo: '10' });
    expect(out?.[2]).toMatchObject({ kind: 'match', path: 'src/a.ts', lineNo: '12' });
  });

  it('renders command failures with status and stderr preview rows', () => {
    const out = formatToolVisualOutput(
      'bash',
      ['bash: pnpm test (exit_code=1)', 'stdout:', 'running tests', 'stderr:', 'boom'].join('\n'),
      false,
    );
    expect(out?.[0]).toMatchObject({ kind: 'error', marker: 'x ', text: 'bash exit 1' });
    expect(out?.some((row) => row.kind === 'stderr' && row.text === 'boom')).toBe(true);
  });

  it('renders verifier report status rows', () => {
    const passed = formatToolVisualOutput(
      'typecheck',
      [
        'typecheck (exit_code=0 errors=0)',
        'report:',
        'status=passed',
        'errors=0',
        'warnings=1',
      ].join('\n'),
      true,
    );
    expect(passed?.[0]).toMatchObject({ kind: 'ok', marker: 'ok ' });
    expect(passed?.[0]?.text).toContain('1 warning');

    const changed = formatToolVisualOutput(
      'format',
      ['format (exit_code=0 files_changed=2)', 'report:', 'status=changed', 'files_changed=2'].join(
        '\n',
      ),
      true,
    );
    expect(changed?.[0]).toMatchObject({ kind: 'warn', marker: '! ' });
    expect(changed?.[0]?.text).toContain('2 changed');
  });

  it('renders fetch status with HTTP severity', () => {
    const ok = formatToolVisualOutput(
      'fetch',
      ['fetch: https://x (status=200 content_type=text/html)', '<html>Hello</html>'].join('\n'),
      true,
    );
    expect(ok?.[0]).toMatchObject({ kind: 'ok', marker: 'ok ', text: 'HTTP 200 · text/html' });

    const bad = formatToolVisualOutput(
      'fetch',
      ['fetch: https://x (status=500 content_type=text/plain)', 'server exploded'].join('\n'),
      false,
    );
    expect(bad?.[0]).toMatchObject({ kind: 'error', marker: 'x ' });
  });

  it('renders todo, plan, and task summaries', () => {
    expect(
      formatToolVisualOutput('todo', JSON.stringify({ count: 3, in_progress: 1 }), true)?.[0],
    ).toMatchObject({ kind: 'ok', marker: 'ok ', text: '3 todos · 1 in progress' });

    const plan = formatToolVisualOutput(
      'plan',
      JSON.stringify({
        ok: true,
        message: 'add ok',
        count: 2,
        open: 1,
        plan: '1. Build UI\n2. Ship',
      }),
      true,
    );
    expect(plan?.[0]).toMatchObject({ kind: 'ok', marker: 'ok ' });
    expect(plan?.[0]?.text).toContain('2 items');
    expect(plan?.some((row) => row.text.includes('Build UI'))).toBe(true);

    const task = formatToolVisualOutput(
      'task',
      JSON.stringify({
        ok: false,
        message: 'Task "x" not found.',
        count: 0,
        completed: 0,
        inProgress: 0,
      }),
      false,
    );
    expect(task?.[0]).toMatchObject({ kind: 'error', marker: 'x ' });
  });

  it('renders memory writes and memory search results', () => {
    expect(
      formatToolVisualOutput(
        'remember',
        JSON.stringify({ ok: true, scope: 'project-memory' }),
        true,
      )?.[0],
    ).toMatchObject({ kind: 'ok', marker: 'ok ', text: 'remember · project-memory' });

    const search = formatToolVisualOutput(
      'search_memory',
      JSON.stringify({
        results: [
          { text: 'Use pnpm', scope: 'project-memory', type: 'convention', priority: 'high' },
        ],
      }),
      true,
    );
    expect(search?.[0]).toMatchObject({ kind: 'meta', marker: '! ' });
    expect(search?.[0]?.text).toContain('[convention]');
    expect(search?.[0]?.text).toContain('Use pnpm');
  });

  it('renders logs and document previews', () => {
    const logs = formatToolVisualOutput(
      'logs',
      JSON.stringify({
        source: 'app.log',
        total: 2,
        truncated: false,
        entries: [
          { timestamp: 't1', level: 'info', message: 'started' },
          { timestamp: 't2', level: 'error', message: 'boom' },
        ],
      }),
      true,
    );
    expect(logs?.[0]?.text).toContain('2 entries');
    expect(logs?.some((row) => row.kind === 'error' && row.text.includes('boom'))).toBe(true);

    const docs = formatToolVisualOutput(
      'document',
      JSON.stringify({
        files_processed: 1,
        items_documented: 2,
        style: 'jsdoc',
        results: [{ path: 'src/a.ts', name: 'makeThing', status: 'documented' }],
      }),
      true,
    );
    expect(docs?.[0]?.text).toContain('2 documented');
    expect(docs?.[1]).toMatchObject({ kind: 'path', marker: '+ ', path: 'src/a.ts' });
  });

  it('renders tool catalog and meta execution tools', () => {
    const catalog = formatToolVisualOutput(
      'tool_search',
      JSON.stringify({
        total: 2,
        tools: [
          { name: 'read', description: 'Read files', permission: 'auto', mutating: false },
          { name: 'write', description: 'Write files', permission: 'confirm', mutating: true },
        ],
      }),
      true,
    );
    expect(catalog?.[0]).toMatchObject({ kind: 'ok', marker: 'ok ' });
    expect(catalog?.some((row) => row.text.includes('write'))).toBe(true);

    expect(
      formatToolVisualOutput(
        'tool_use',
        JSON.stringify({ tool: 'read', success: true, executionMs: 12 }),
        true,
      )?.[0],
    ).toMatchObject({ kind: 'ok', marker: 'ok ', text: 'read · 12ms' });

    const batch = formatToolVisualOutput(
      'batch_tool_use',
      JSON.stringify({
        total: 2,
        succeeded: 1,
        failed: 1,
        results: [
          { tool: 'read', success: true, executionMs: 5 },
          { tool: 'write', success: false, error: 'denied', executionMs: 7 },
        ],
      }),
      false,
    );
    expect(batch?.[0]).toMatchObject({ kind: 'error', marker: 'x ' });
    expect(batch?.some((row) => row.text.includes('write') && row.text.includes('denied'))).toBe(
      true,
    );
  });

  it('renders codebase index/search/stats and context tools', () => {
    const search = formatToolVisualOutput(
      'codebase-search',
      JSON.stringify({
        query: 'agent',
        total: 1,
        results: [{ file: 'src/agent.ts', line: 42, kind: 'class', name: 'Agent' }],
      }),
      true,
    );
    expect(search?.[0]?.text).toContain('1 symbol result');
    expect(search?.[1]).toMatchObject({ kind: 'match', path: 'src/agent.ts', lineNo: '42' });

    expect(
      formatToolVisualOutput(
        'codebase-index',
        JSON.stringify({ filesIndexed: 4, symbolsIndexed: 20, durationMs: 1500, errors: [] }),
        true,
      )?.[0]?.text,
    ).toContain('4 files');

    expect(
      formatToolVisualOutput(
        'codebase-stats',
        JSON.stringify({ totalSymbols: 20, totalFiles: 4, sizeBytes: 1024 }),
        true,
      )?.[0]?.text,
    ).toContain('20 symbols');

    expect(
      formatToolVisualOutput(
        'set_working_dir',
        JSON.stringify({ current: 'D:/repo/src', previous: 'D:/repo', message: 'changed' }),
        true,
      )?.[0],
    ).toMatchObject({ kind: 'ok', marker: 'ok ', path: 'D:/repo/src' });

    const mode = formatToolVisualOutput(
      'mode',
      JSON.stringify({
        action: 'list',
        success: true,
        modes: [{ id: 'review', name: 'Review', description: 'Find bugs' }],
      }),
      true,
    );
    expect(mode?.[0]?.text).toContain('1 mode');
    expect(mode?.[1]?.text).toContain('review');
  });
});

describe('formatToolVisualOutput — edit-style tools', () => {
  it('renders edit tool: path + replacement count', () => {
    const out = formatToolVisualOutput(
      'edit',
      JSON.stringify({
        path: 'src/foo.ts',
        replacements: 3,
        diff: '@@ -1 +1 @@\n-old\n+new\n',
      }),
      true,
    );
    // First row: 'edit <path>' marker, kind 'ok'
    expect(out?.[0]).toMatchObject({ kind: 'ok', marker: 'edit ', path: 'src/foo.ts' });
    // Second row: '3 replacements' meta
    expect(out?.[1]).toMatchObject({ kind: 'meta', text: '3 replacements' });
  });

  it('renders write tool: path + bytes', () => {
    const out = formatToolVisualOutput(
      'write',
      JSON.stringify({ path: 'src/bar.ts', bytes: 256 }),
      true,
    );
    expect(out?.[0]).toMatchObject({ kind: 'ok', marker: 'write ', path: 'src/bar.ts' });
    expect(out?.[1]).toMatchObject({ kind: 'meta', text: '256 bytes' });
  });

  it('renders write tool new-file path', () => {
    const out = formatToolVisualOutput(
      'write',
      JSON.stringify({ path: 'src/new.ts', created: true }),
      true,
    );
    expect(out?.[0]).toMatchObject({ kind: 'ok', marker: 'write ', path: 'src/new.ts' });
    expect(out?.[1]).toMatchObject({ kind: 'meta', text: 'new file' });
  });

  it('renders diff tool: file count', () => {
    const out = formatToolVisualOutput(
      'diff',
      JSON.stringify({
        files: ['a.ts', 'b.ts', 'c.ts'],
        diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@\n-x\n+y\n',
      }),
      true,
    );
    expect(out?.[0]).toMatchObject({ kind: 'ok', marker: 'diff ', text: '3 files' });
  });

  it('renders replace tool: replacement + file count from results', () => {
    const out = formatToolVisualOutput(
      'replace',
      JSON.stringify({
        results: [
          { path: 'a.ts', diff: '@@\n-x\n+y\n' },
          { path: 'b.ts', diff: '@@\n-x\n+y\n' },
          { path: 'a.ts', diff: '@@\n-x\n+y\n' },
        ],
      }),
      true,
    );
    expect(out?.[0]).toMatchObject({ kind: 'ok', marker: 'replace ' });
    expect(out?.[0]?.text).toContain('3 replacements');
    expect(out?.[0]?.text).toContain('across 2 files');
  });

  it('appends an error row when the call failed', () => {
    const out = formatToolVisualOutput(
      'edit',
      JSON.stringify({ path: 'src/foo.ts', replacements: 0 }),
      false,
    );
    expect(out?.some((row) => row.kind === 'error')).toBe(true);
  });

  it('falls back to first non-empty line for non-JSON output', () => {
    const out = formatToolVisualOutput('edit', 'plain text output line one\nline two', true);
    expect(out?.[0]).toMatchObject({ kind: 'meta' });
    expect(out?.[0]?.text).toContain('plain text output line one');
  });
});

describe('fmtDuration', () => {
  it('renders ms below 1s', () => {
    expect(fmtDuration(0)).toBe('0ms');
    expect(fmtDuration(42)).toBe('42ms');
    expect(fmtDuration(999)).toBe('999ms');
  });

  it('renders seconds with one decimal up to 1 minute', () => {
    expect(fmtDuration(1_000)).toBe('1.0s');
    expect(fmtDuration(45_300)).toBe('45.3s');
  });

  it('renders Xm Ys at one minute and above', () => {
    expect(fmtDuration(60_000)).toBe('1m0s');
    expect(fmtDuration(75_000)).toBe('1m15s');
    expect(fmtDuration(3_600_000)).toBe('60m0s');
  });
});
