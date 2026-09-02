import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Entry, type HistoryEntry } from '../src/components/history.js';
import { parseSageMemoryLine } from '../src/components/history/sage-output-format.js';
import { estimateRenderGroupRows, type RenderGroup } from '../src/components/history/tool-group.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

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

const SAGE_BLOCK_RICH = [
  '--- SAGE: related project knowledge (Memory Injector) ---',
  '- [fact][critical] <memory id="mem-01">TUI dist wiped by pnpm install</memory> (packages/tui) [relation=about_package; tags=tui,build,workspace]',
  '- [decision][high] <memory id="mem-02">Use flex-wrap for kv rows</memory> [tags=rendering]',
  '- [warning][medium] <memory id="mem-03">Watcher leaks fd on error</memory> (packages/sage/src) [relation=about_directory; tags=fs]',
].join('\n');

describe('SageMemoryBlock structured render', () => {
  it('renders each memory label as bold accent text', () => {
    const contaminated = `${JSON.stringify({ files: ['src/a.ts'] })}\n\n${SAGE_BLOCK_RICH}`;
    const frame = renderEntry({
      id: 1,
      kind: 'tool',
      name: 'glob',
      durationMs: 12,
      ok: true,
      input: { pattern: 'src/**/*.ts' },
      output: contaminated,
    });
    expect(frame).toContain('[fact][critical]');
    expect(frame).toContain('[decision][high]');
    expect(frame).toContain('[warning][medium]');
  });

  it('renders memory body text in primary foreground color', () => {
    const contaminated = `${JSON.stringify({ files: ['src/a.ts'] })}\n\n${SAGE_BLOCK_RICH}`;
    const frame = renderEntry({
      id: 2,
      kind: 'tool',
      name: 'glob',
      durationMs: 12,
      ok: true,
      input: { pattern: 'src/**/*.ts' },
      output: contaminated,
    });
    expect(frame).toContain('TUI dist wiped by pnpm install');
    expect(frame).toContain('Use flex-wrap for kv rows');
    expect(frame).toContain('Watcher leaks fd on error');
  });

  it('renders id/anchor/relation/tags key/value rows', () => {
    const contaminated = `${JSON.stringify({ files: ['src/a.ts'] })}\n\n${SAGE_BLOCK_RICH}`;
    const frame = renderEntry({
      id: 3,
      kind: 'tool',
      name: 'glob',
      durationMs: 12,
      ok: true,
      input: { pattern: 'src/**/*.ts' },
      output: contaminated,
    });
    expect(frame).toContain('id: mem-01');
    expect(frame).toContain('anchor: packages/tui');
    expect(frame).toContain('relation: about_package');
    // Ink's flex-wrap row lays each <SageKv> with marginRight={2}, so the
    // joined cells in the rendered frame appear as "  " separated; the
    // parser still preserves the comma list inside the tags cell.
    expect(frame).toContain('tags: tui, build, workspace');
    // second memory has no anchor; verify the id row still shows
    expect(frame).toContain('id: mem-02');
    // third memory has tags
    expect(frame).toContain('tags: fs');
  });

  it('still surfaces the panel header with tool name', () => {
    const contaminated = `${JSON.stringify({ files: ['src/a.ts'] })}\n\n${SAGE_BLOCK_RICH}`;
    const frame = renderEntry({
      id: 4,
      kind: 'tool',
      name: 'glob',
      durationMs: 12,
      ok: true,
      input: { pattern: 'src/**/*.ts' },
      output: contaminated,
    });
    expect(frame).toContain('SAGE MEMORY INJECTED · glob');
    expect(frame).toContain('3 memories');
  });

  it('keeps the SAGE block separate from the tool result body', () => {
    const contaminated = `${JSON.stringify({ files: ['src/a.ts'] })}\n\n${SAGE_BLOCK_RICH}`;
    const frame = renderEntry({
      id: 5,
      kind: 'tool',
      name: 'glob',
      durationMs: 12,
      ok: true,
      input: { pattern: 'src/**/*.ts' },
      output: contaminated,
    });
    expect(frame).toContain('src/a.ts');
    expect(frame).not.toContain('--- SAGE:');
  });

  // Replayed entries omit `sageLines` per the documented contract on
  // `HistoryEntry` — the inline form is recovered from `output` via
  // `extractSageBlock`. The renderer must not crash on the absent form; a
  // missing structured block just means "no extra panel".
  it('does not crash when sageLines is undefined (replayed entry)', () => {
    const inline = `${JSON.stringify({ files: ['src/a.ts'] })}\n\n${SAGE_BLOCK_RICH}`;
    expect(() =>
      renderEntry({
        id: 6,
        kind: 'tool',
        name: 'glob',
        durationMs: 12,
        ok: true,
        input: { pattern: 'src/**/*.ts' },
        output: inline,
        // explicitly no sageLines
      }),
    ).not.toThrow();
  });
});

describe('parseSageMemoryLine', () => {
  it('parses labels, id, text, anchor, relation, tags', () => {
    const parsed = parseSageMemoryLine(
      '- [fact][critical] <memory id="mem-01">hello</memory> (packages/tui) [relation=about_package; tags=tui,build]',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.labels).toEqual(['fact', 'critical']);
    expect(parsed!.id).toBe('mem-01');
    expect(parsed!.text).toBe('hello');
    expect(parsed!.anchor).toBe('packages/tui');
    expect(parsed!.relation).toBe('about_package');
    expect(parsed!.tags).toEqual(['tui', 'build']);
  });

  it('unescapes fence entities in the body', () => {
    const parsed = parseSageMemoryLine(
      '- [fact] <memory id="x">User&#39;s &amp; &quot;data&quot;</memory> [tags=special]',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe('User\'s & "data"');
  });

  it('returns null for malformed lines', () => {
    expect(parseSageMemoryLine('not a memory line')).toBeNull();
    expect(parseSageMemoryLine('')).toBeNull();
  });
});

describe('estimateRenderGroupRows — SAGE structured layout', () => {
  it('matches the real Ink row count for structured memory layout', async () => {
    const width = 46;
    const header = '--- SAGE: related project knowledge (Memory Injector) ---';
    const mem1 =
      '- [fact][critical] <memory id="mem-01">A Unicode 🧠 body wraps using terminal display width.</memory> (packages/tui) [relation=about_package; tags=tui,build,workspace]';
    const sageLines = [header, mem1];
    const output = [JSON.stringify({ files: ['src/a.ts'] }), '', header, mem1].join('\n');
    const entry: Extract<HistoryEntry, { kind: 'tool' }> = {
      id: 100,
      kind: 'tool',
      name: 'glob',
      durationMs: 12,
      ok: true,
      input: { pattern: 'src/**/*.ts' },
      output,
      sageLines,
    };
    const group: RenderGroup = { type: 'single', entry };
    const view = renderRealTty(React.createElement(Entry, { entry, termWidth: width }), {
      columns: width,
      rows: 40,
    });

    await settle();
    const renderedRows = view.lines().length;
    const estimatorRows = estimateRenderGroupRows(group, width);
    view.unmount();

    // The estimator and the Ink renderer must agree within a small constant
    // drift: the renderer adds a top + bottom border for the ToolCard chrome
    // and may add 1 row when a flex-wrap cell is the only one on its visual
    // row (Ink keeps the trailing marginRight={2} as a single column). The
    // estimator does not model these because they are bounded and the
    // height-cache absorbs the residual via later measurement. A 3-row
    // tolerance covers both effects without hiding real drift.
    const drift = Math.abs(renderedRows - estimatorRows);
    expect(drift).toBeLessThanOrEqual(3);
  }, 5000);
});
