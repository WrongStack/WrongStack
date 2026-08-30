import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Entry, type HistoryEntry } from '../src/components/history.js';

function renderEntry(entry: HistoryEntry): string {
  const { lastFrame, unmount } = render(
    React.createElement(Entry, {
      entry,
      termWidth: 100,
    }),
  );
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

describe('<Entry /> tool rendering', () => {
  it('renders semantic grep result rows inside tool entries', () => {
    const frame = renderEntry({
      id: 1,
      kind: 'tool',
      name: 'grep',
      durationMs: 18,
      ok: true,
      input: { pattern: 'Widget' },
      output: JSON.stringify({
        count: 1,
        matches: [{ file: 'src/a.ts', line: 42, text: 'const Widget = makeWidget();' }],
      }),
    });

    expect(frame).toContain('grep');
    expect(frame).toContain('"Widget"');
    expect(frame).toContain('src/a.ts');
    expect(frame).toContain('42');
    expect(frame).toContain('const Widget = makeWidget();');
  });

  it('renders new-file write diffs with a Write(path) header', () => {
    const frame = renderEntry({
      id: 2,
      kind: 'tool',
      name: 'write',
      durationMs: 31,
      ok: true,
      input: { path: 'src/new.ts', content: 'alpha\nbeta' },
      output: JSON.stringify({
        path: 'src/new.ts',
        created: true,
        diff: '+++ src/new.ts\n+ (new file, 2 lines)',
      }),
    });

    // `created: true` → Claude-Code-style header: ● Write(path)
    expect(frame).toContain('Write(src/new.ts)');
    expect(frame).toContain('⎿');
    expect(frame).toContain('Added 2 lines');
    expect(frame).toContain('alpha');
    expect(frame).toContain('beta');
  });

  it('renders write_to_file alias diffs with the Write(path) header', () => {
    const frame = renderEntry({
      id: 20,
      kind: 'tool',
      name: 'write_to_file',
      durationMs: 31,
      ok: true,
      input: { path: 'src/new.ts', content: 'alpha\nbeta' },
      output: JSON.stringify({
        path: 'src/new.ts',
        created: true,
        diff: '+++ src/new.ts\n+ (new file, 2 lines)',
      }),
    });

    // Alias of `write`: canonicalized for extraction, header still Write(path).
    expect(frame).toContain('Write(src/new.ts)');
    expect(frame).toContain('⎿');
    expect(frame).toContain('Added 2 lines');
  });

  it('renders replace_file_content alias diffs with the Update(path) header', () => {
    const frame = renderEntry({
      id: 21,
      kind: 'tool',
      name: 'replace_file_content',
      durationMs: 22,
      ok: true,
      input: { path: 'src/a.ts', old_string: 'old line', new_string: 'new line' },
      output: JSON.stringify({
        path: 'src/a.ts',
        diff: '--- src/a.ts\n+++ src/a.ts\n@@ -1,1 +1,1 @@\n-old line\n+new line',
      }),
    });

    // Alias of `edit`: canonicalized for extraction, header stays Update(path).
    expect(frame).toContain('Update(src/a.ts)');
    expect(frame).toContain('⎿');
  });

  it('renders batch tool execution rows with failed child details', () => {
    const frame = renderEntry({
      id: 3,
      kind: 'tool',
      name: 'batch_tool_use',
      durationMs: 44,
      ok: false,
      input: { calls: [{ tool: 'read' }, { tool: 'write' }] },
      output: JSON.stringify({
        total: 2,
        succeeded: 1,
        failed: 1,
        results: [
          { tool: 'read', success: true, executionMs: 5 },
          { tool: 'write', success: false, error: 'denied', executionMs: 7 },
        ],
      }),
    });

    expect(frame).toContain('batch_tool_use');
    expect(frame).toContain('1/2 succeeded');
    expect(frame).toContain('write');
    expect(frame).toContain('denied');
  });

  it('renders edit entries with an Update(path) header + stats line above the diff body', () => {
    const frame = renderEntry({
      id: 4,
      kind: 'tool',
      name: 'edit',
      durationMs: 12,
      ok: true,
      input: { path: 'src/foo.ts', old_string: 'a', new_string: 'b' },
      output: JSON.stringify({
        path: 'src/foo.ts',
        replacements: 1,
        diff: [
          'diff --git a/src/foo.ts b/src/foo.ts',
          '--- a/src/foo.ts',
          '+++ b/src/foo.ts',
          '@@ -1 +1 @@',
          '-a',
          '+b',
        ].join('\n'),
      }),
    });

    // Header: ● Update(path)
    expect(frame).toContain('Update(src/foo.ts)');
    // Stats line: ⎿  Added 1 line, removed 1 line
    expect(frame).toContain('Added 1 line, removed 1 line');
    // Diff body below (single line-number gutter + marker + text).
    expect(frame).toMatch(/1 \+ b/);
    expect(frame).toMatch(/1 - a/);
  });

  it('renders write meta line (path + bytes)', () => {
    const frame = renderEntry({
      id: 5,
      kind: 'tool',
      name: 'write',
      durationMs: 8,
      ok: true,
      input: { path: 'src/bar.ts', content: 'hello\nworld' },
      output: JSON.stringify({ path: 'src/bar.ts', bytes: 11 }),
    });

    expect(frame).toContain('write');
    expect(frame).toContain('src/bar.ts');
    expect(frame).toContain('11 bytes');
  });

  it('renders read output as one compact line without numbered file preview', () => {
    const frame = renderEntry({
      id: 6,
      kind: 'tool',
      name: 'read',
      durationMs: 9,
      ok: true,
      input: { path: 'src/a.ts' },
      output: ['read: src/a.ts (total_lines=3)', '1→const a = 1;', '2→const b = 2;'].join('\n'),
      outputLines: 2,
    });

    expect(frame).toContain('read');
    expect(frame).toContain('src/a.ts');
    expect(frame).toContain('L1–2 · 2 lines · 3 total');
    expect(frame).not.toContain('const a = 1;');
    expect(frame).not.toContain('const b = 2;');
  });

  it('does not render the diff body in simple result-render mode for edit', () => {
    const frame = renderEntry({
      id: 7,
      kind: 'tool',
      name: 'edit',
      durationMs: 12,
      ok: true,
      resultRenderMode: 'simple',
      input: { path: 'src/foo.ts', old_string: 'a', new_string: 'b' },
      output: JSON.stringify({
        path: 'src/foo.ts',
        replacements: 1,
        diff: [
          'diff --git a/src/foo.ts b/src/foo.ts',
          '--- a/src/foo.ts',
          '+++ b/src/foo.ts',
          '@@ -1 +1 @@',
          '-a',
          '+b',
        ].join('\n'),
      }),
    });

    // Header + stats line: still present.
    expect(frame).toContain('Update(src/foo.ts)');
    expect(frame).toContain('Added 1 line, removed 1 line');
    // Diff BODY is hidden — the changed-line rows must not appear in the
    // simple render.
    expect(frame).not.toMatch(/1 - a/);
    expect(frame).not.toMatch(/1 \+ b/);
  });
});
