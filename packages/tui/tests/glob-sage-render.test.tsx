import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Entry, type HistoryEntry } from '../src/components/history.js';

function renderEntry(entry: HistoryEntry, opts: { termWidth?: number } = {}): string {
  const { lastFrame, unmount } = render(
    React.createElement(Entry, {
      entry,
      termWidth: opts.termWidth ?? 100,
    }),
  );
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

const SAGE_BLOCK = [
  '--- SAGE: related project knowledge (Memory Injector) ---',
  '- [fact] <memory id="mem-1">remembered glob fact</memory> [tags=glob]',
  '- [decision][high] <memory id="mem-2">remembered glob decision</memory>',
].join('\n');

describe('glob tool result — SAGE injection as separate section', () => {
  it('renders glob JSON output without the SAGE header in the result body', () => {
    const globOutput = JSON.stringify({ files: ['src/a.ts', 'src/b.tsx'] });
    const contaminated = `${globOutput}\n\n${SAGE_BLOCK}\n`;
    const frame = renderEntry({
      id: 1,
      kind: 'tool',
      name: 'glob',
      durationMs: 12,
      ok: true,
      input: { pattern: 'packages/**/*.ts' },
      output: contaminated,
    });
    // The glob result body must still surface the file paths.
    expect(frame).toContain('src/a.ts');
    expect(frame).toContain('src/b.tsx');
    // The SAGE header must NOT appear in the result body — only in the
    // separate bordered memory panel.
    expect(frame).not.toContain('--- SAGE:');
    // The separate panel header must mention the tool name.
    expect(frame).toContain('SAGE MEMORY INJECTED · glob');
    // The memory text must appear (in the panel, not the result).
    expect(frame).toContain('remembered glob fact');
  });

  it('renders glob tree-style output (count + first path) with SAGE separately', () => {
    const globText = 'glob (count=2)\nsrc/a.ts\nsrc/b.tsx';
    const contaminated = `${globText}\n\n${SAGE_BLOCK}`;
    const frame = renderEntry({
      id: 2,
      kind: 'tool',
      name: 'glob',
      durationMs: 9,
      ok: true,
      input: { pattern: 'packages/**/*.ts' },
      output: contaminated,
    });
    expect(frame).toContain('src/a.ts');
    expect(frame).not.toContain('--- SAGE:');
    expect(frame).toContain('SAGE MEMORY INJECTED · glob');
    expect(frame).toContain('remembered glob decision');
  });

  it('renders glob with empty SAGE memory cleanly (no orphan panel)', () => {
    const frame = renderEntry({
      id: 3,
      kind: 'tool',
      name: 'glob',
      durationMs: 4,
      ok: true,
      input: { pattern: 'src/*.ts' },
      output: JSON.stringify({ files: ['src/x.ts'] }),
    });
    expect(frame).toContain('src/x.ts');
    expect(frame).not.toContain('SAGE MEMORY INJECTED');
    expect(frame).not.toContain('--- SAGE:');
  });

  it('renders grep JSON output with SAGE separately (regression for read-style tools)', () => {
    const grepOutput = JSON.stringify({
      matches: [{ file: 'a.ts', line: 1, text: 'foo' }],
      count: 1,
    });
    const contaminated = `${grepOutput}\n\n${SAGE_BLOCK}`;
    const frame = renderEntry({
      id: 4,
      kind: 'tool',
      name: 'grep',
      durationMs: 5,
      ok: true,
      input: { pattern: 'foo' },
      output: contaminated,
    });
    expect(frame).toContain('a.ts');
    expect(frame).not.toContain('--- SAGE:');
    expect(frame).toContain('SAGE MEMORY INJECTED · grep');
    expect(frame).toContain('remembered glob fact');
  });

  it('renders tree JSON output with SAGE separately (regression for tree-style tools)', () => {
    const treeOutput = JSON.stringify({
      total_files: 3,
      total_dirs: 1,
      truncated: false,
      entries: [{ path: 'src/a.ts', kind: 'file' }],
    });
    const contaminated = `${treeOutput}\n\n${SAGE_BLOCK}`;
    const frame = renderEntry({
      id: 5,
      kind: 'tool',
      name: 'tree',
      durationMs: 6,
      ok: true,
      input: { path: 'src' },
      output: contaminated,
    });
    // tree formatter summarises the JSON body ("3 files · 1 dir") rather
    // than dumping every entry. Assert on that summary plus the bordered
    // SAGE panel as a separate section.
    expect(frame).toContain('3 files');
    expect(frame).toContain('1 dir');
    expect(frame).not.toContain('--- SAGE:');
    expect(frame).toContain('SAGE MEMORY INJECTED · tree');
  });

  it('renders codebase_search output with SAGE separately (regression for search tools)', () => {
    const searchOutput = JSON.stringify({
      results: [{ path: 'foo.ts', line: 5 }],
      count: 1,
    });
    const contaminated = `${searchOutput}\n\n${SAGE_BLOCK}`;
    const frame = renderEntry({
      id: 6,
      kind: 'tool',
      name: 'codebase_search',
      durationMs: 7,
      ok: true,
      input: { query: 'foo' },
      output: contaminated,
    });
    // codebase_search summarises the JSON body. Assert on that summary
    // plus the bordered SAGE panel as a separate section.
    expect(frame).toContain('count=1');
    expect(frame).not.toContain('--- SAGE:');
    expect(frame).toContain('SAGE MEMORY INJECTED · codebase_search');
  });

  it('renders read JSON output with SAGE separately (regression for read tool)', () => {
    const readOutput = JSON.stringify({ bytes: 42, path: 'src/foo.ts' });
    const contaminated = `${readOutput}\n\n${SAGE_BLOCK}`;
    const frame = renderEntry({
      id: 7,
      kind: 'tool',
      name: 'read',
      durationMs: 3,
      ok: true,
      input: { path: 'src/foo.ts' },
      output: contaminated,
    });
    // The read body shows the path; SAGE header must not appear in it.
    expect(frame).toContain('src/foo.ts');
    expect(frame).not.toContain('--- SAGE:');
    expect(frame).toContain('SAGE MEMORY INJECTED · read');
    expect(frame).toContain('remembered glob fact');
  });

  it('renders read serialized-text output with SAGE separately', () => {
    const readText = 'read (path=src/foo.ts, total_lines=2)\n  1→const x;\n  2→const y;';
    const contaminated = `${readText}\n\n${SAGE_BLOCK}`;
    const frame = renderEntry({
      id: 8,
      kind: 'tool',
      name: 'read',
      durationMs: 4,
      ok: true,
      input: { path: 'src/foo.ts' },
      output: contaminated,
    });
    expect(frame).toContain('src/foo.ts');
    expect(frame).not.toContain('--- SAGE:');
    expect(frame).toContain('SAGE MEMORY INJECTED · read');
  });

  it('renders edit JSON output with SAGE separately (regression for edit tool)', () => {
    const editOutput = JSON.stringify({
      path: 'src/a.ts',
      replacements: 1,
      diff: '--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-a\n+b',
    });
    const contaminated = `${editOutput}\n\n${SAGE_BLOCK}`;
    const frame = renderEntry({
      id: 9,
      kind: 'tool',
      name: 'edit',
      durationMs: 11,
      ok: true,
      input: { path: 'src/a.ts', old_string: 'a', new_string: 'b' },
      output: contaminated,
    });
    // The edit header still surfaces as Update(path) and the diff body is
    // rendered without contamination.
    expect(frame).toContain('Update(src/a.ts)');
    expect(frame).not.toContain('--- SAGE:');
    expect(frame).toContain('SAGE MEMORY INJECTED · edit');
    expect(frame).toContain('remembered glob decision');
  });

  it('renders patch JSON output with SAGE separately (regression for patch tool)', () => {
    const patchOutput = JSON.stringify({
      applied: 1,
      rejected: 0,
      files: ['src/c.ts'],
    });
    const contaminated = `${patchOutput}\n\n${SAGE_BLOCK}`;
    const frame = renderEntry({
      id: 10,
      kind: 'tool',
      name: 'patch',
      durationMs: 14,
      ok: true,
      input: { directory: 'src', patch: '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y' },
      output: contaminated,
    });
    expect(frame).toContain('patch 1 file');
    expect(frame).not.toContain('--- SAGE:');
    expect(frame).toContain('SAGE MEMORY INJECTED · patch');
  });

  it('renders replace multi-file JSON output with SAGE separately (regression for replace tool)', () => {
    const replaceOutput = JSON.stringify({
      files_modified: 2,
      total_replacements: 4,
      files: ['src/a.ts', 'src/b.ts'],
    });
    const contaminated = `${replaceOutput}\n\n${SAGE_BLOCK}`;
    const frame = renderEntry({
      id: 11,
      kind: 'tool',
      name: 'replace',
      durationMs: 22,
      ok: true,
      input: { pattern: 'a', replacement: 'b', files: 'src/a.ts,src/b.ts' },
      output: contaminated,
    });
    expect(frame).toContain('replacement');
    expect(frame).not.toContain('--- SAGE:');
    expect(frame).toContain('SAGE MEMORY INJECTED · replace');
    expect(frame).toContain('remembered glob fact');
  });

  it('renders write serialized-text output with SAGE separately (regression for write tool)', () => {
    const writeOutput = JSON.stringify({
      created: false,
      path: 'src/d.ts',
      diff: '--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-old\n+new',
    });
    const contaminated = `${writeOutput}\n\n${SAGE_BLOCK}`;
    const frame = renderEntry({
      id: 12,
      kind: 'tool',
      name: 'write',
      durationMs: 18,
      ok: true,
      input: { path: 'src/d.ts', content: 'new' },
      output: contaminated,
    });
    expect(frame).toContain('Update(src/d.ts)');
    expect(frame).not.toContain('--- SAGE:');
    expect(frame).toContain('SAGE MEMORY INJECTED · write');
  });
});
