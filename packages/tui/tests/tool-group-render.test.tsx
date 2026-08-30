import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ToolCard } from '../src/components/history/tool-card.js';
import {
  estimateRenderGroupRows,
  groupEntries,
  ToolGroup,
  type ToolGroupData,
} from '../src/components/history/tool-group.js';
import { Text } from '../src/ink.js';
import { displayWidth } from '../src/terminal-width.js';
import { extractSageBlock } from '../src/components/history/utils.js';

const injectedMemory = [
  '--- SAGE: related project knowledge (Memory Injector) ---',
  '- [fact] <memory id="mem-1">remembered fact</memory>',
].join('\n');

describe('SAGE output separation and grouping', () => {
  it('leaves ordinary SAGE-like output untouched', () => {
    const output = ['command output', '--- SAGE: example from a fixture', 'still ordinary output'].join('\n');
    expect(extractSageBlock(output)).toEqual({ cleanOutput: output, sageLines: [] });
  });

  it('extracts a complete terminal injector suffix', () => {
    expect(extractSageBlock(`command output\n\n${injectedMemory}`)).toEqual({
      cleanOutput: 'command output',
      sageLines: injectedMemory.split('\n'),
    });
  });

  it('splits compact groups around an entry with injected memory', () => {
    const groups = groupEntries([
      { id: 1, kind: 'tool', name: 'read', durationMs: 1, ok: true, output: 'first' },
      { id: 2, kind: 'tool', name: 'read', durationMs: 1, ok: true, output: 'second' },
      { id: 3, kind: 'tool', name: 'read', durationMs: 1, ok: true, output: `third\n\n${injectedMemory}` },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ type: 'tool-group', data: { entries: [{ id: 1 }, { id: 2 }] } });
    expect(groups[1]).toMatchObject({ type: 'single', entry: { id: 3 } });
  });

  it('includes the independent memory panel in virtual row estimates', () => {
    const base = estimateRenderGroupRows(
      {
        type: 'single',
        entry: { id: 1, kind: 'tool', name: 'write', durationMs: 1, ok: true, resultRenderMode: 'simple' },
      },
      80,
    );
    const injected = estimateRenderGroupRows(
      {
        type: 'single',
        entry: {
          id: 2,
          kind: 'tool',
          name: 'write',
          durationMs: 1,
          ok: true,
          resultRenderMode: 'simple',
          output: injectedMemory,
        },
      },
      80,
    );
    expect(injected).toBeGreaterThan(base);
  });

  it('accounts for wrapped memory content at narrow terminal widths', () => {
    const output = [
      '--- SAGE: related project knowledge (Memory Injector) ---',
      `- [fact] <memory id="mem-1">${'x'.repeat(160)}</memory>`,
    ].join('\n');
    const narrow = estimateRenderGroupRows(
      {
        type: 'single',
        entry: {
          id: 1,
          kind: 'tool',
          name: 'write',
          durationMs: 1,
          ok: true,
          resultRenderMode: 'simple',
          output,
        },
      },
      32,
    );
    const wide = estimateRenderGroupRows(
      {
        type: 'single',
        entry: {
          id: 1,
          kind: 'tool',
          name: 'write',
          durationMs: 1,
          ok: true,
          resultRenderMode: 'simple',
          output,
        },
      },
      120,
    );
    expect(narrow).toBeGreaterThan(wide);
  });

  // ── Regression: trailing blank/whitespace tolerance ──

  it('strips SAGE block followed by a trailing newline', () => {
    const output = `command output\n\n${injectedMemory}\n`;
    const result = extractSageBlock(output);
    expect(result.sageLines.length).toBe(2);
    expect(result.cleanOutput).toBe('command output');
  });

  it('strips SAGE block followed by trailing blank lines', () => {
    const output = `command output\n\n${injectedMemory}\n\n`;
    const result = extractSageBlock(output);
    expect(result.sageLines.length).toBe(2);
    expect(result.cleanOutput).toBe('command output');
  });

  it('strips SAGE block followed by trailing whitespace-only line', () => {
    const output = `command output\n\n${injectedMemory}\n   `;
    const result = extractSageBlock(output);
    expect(result.sageLines.length).toBe(2);
    expect(result.cleanOutput).toBe('command output');
  });

  it('strips SAGE block followed by mixed trailing blank and whitespace lines', () => {
    const output = `command output\n\n${injectedMemory}\n\n  \n\n`;
    const result = extractSageBlock(output);
    expect(result.sageLines.length).toBe(2);
    expect(result.cleanOutput).toBe('command output');
  });

  it('does NOT strip SAGE block followed by non-memory content', () => {
    // A real (non-blank) line after the SAGE block means it's not a
    // terminal suffix — the SAGE-like header might be legitimate tool output.
    const output = `command output\n\n${injectedMemory}\nsome real trailing content`;
    const result = extractSageBlock(output);
    expect(result.sageLines.length).toBe(0);
    expect(result.cleanOutput).toBe(output);
  });

  it('strips SAGE block with multiple memories followed by trailing newline', () => {
    const multiMemory = [
      '--- SAGE: related project knowledge (Memory Injector) ---',
      '- [fact] <memory id="mem-a">first memory</memory> [tags=a]',
      '- [decision][high] <memory id="mem-b">second memory</memory>',
      '- [bug_root_cause][critical] <memory id="mem-c">third memory</memory>',
    ].join('\n');
    const output = `tool result\n\n${multiMemory}\n\n`;
    const result = extractSageBlock(output);
    expect(result.sageLines.length).toBe(4);
    expect(result.cleanOutput).toBe('tool result');
  });
});

describe('<ToolCard /> frame', () => {
  it('leaves the top row blank after a failed tool summary', () => {
    const { lastFrame, unmount } = render(
      React.createElement(
        ToolCard,
        {
          glyph: '▤',
          color: 'blue',
          title: 'read',
          detail: 'src/a.ts',
          meta: '13ms',
          ok: false,
          termWidth: 80,
          hasBody: true,
        },
        React.createElement(Text, null, 'result'),
      ),
    );
    const lines = (lastFrame() ?? '').split('\n');
    const top = lines[0]?.trimEnd() ?? '';
    const bottom = lines.at(-1)?.trimEnd() ?? '';
    unmount();

    expect(top).toContain('read');
    expect(top).toContain('13ms');
    expect(top.match(/─/g)).toHaveLength(1);
    expect(displayWidth(bottom)).toBe(80);
  });
});

describe('estimateRenderGroupRows', () => {
  it('uses width-aware bounded estimates for text entries', () => {
    const short = estimateRenderGroupRows(
      { type: 'single', entry: { id: 1, kind: 'assistant', text: 'short' } },
      80,
    );
    const wrapped = estimateRenderGroupRows(
      { type: 'single', entry: { id: 2, kind: 'assistant', text: 'x'.repeat(400) } },
      40,
    );
    const bounded = estimateRenderGroupRows(
      { type: 'single', entry: { id: 3, kind: 'assistant', text: 'x\n'.repeat(10_000) } },
      40,
    );

    expect(short).toBe(3);
    expect(wrapped).toBeGreaterThan(short);
    expect(bounded).toBe(202);
  });

  it('bounds structured diff estimates and keeps compact groups count-based', () => {
    const diffEstimate = estimateRenderGroupRows(
      {
        type: 'single',
        entry: {
          id: 1,
          kind: 'tool',
          name: 'edit',
          durationMs: 1,
          ok: true,
          output: '+line\n'.repeat(10_000),
        },
      },
      80,
    );
    const data: ToolGroupData = {
      name: 'read',
      totalDurationMs: 2,
      okCount: 2,
      failCount: 0,
      entries: [
        { id: 2, kind: 'tool', name: 'read', durationMs: 1, ok: true },
        { id: 3, kind: 'tool', name: 'read', durationMs: 1, ok: true },
      ],
    };

    expect(diffEstimate).toBe(203);
    expect(estimateRenderGroupRows({ type: 'tool-group', data }, 80)).toBe(4);
  });
});

describe('<ToolGroup /> frame', () => {
  it('leaves the top row blank after a failed group summary', () => {
    const data: ToolGroupData = {
      name: 'read',
      totalDurationMs: 35,
      okCount: 2,
      failCount: 1,
      entries: [
        { id: 1, kind: 'tool', name: 'read', durationMs: 13, ok: true, input: { path: 'a.ts' } },
        { id: 2, kind: 'tool', name: 'read', durationMs: 9, ok: false, input: { path: 'b.ts' } },
        { id: 3, kind: 'tool', name: 'read', durationMs: 13, ok: true, input: { path: 'c.ts' } },
      ],
    };

    const { lastFrame, unmount } = render(React.createElement(ToolGroup, { data, termWidth: 80 }));
    const lines = (lastFrame() ?? '').split('\n');
    const top = lines[0]?.trimEnd() ?? '';
    const bottom = lines.at(-1)?.trimEnd() ?? '';
    unmount();

    expect(top).toContain('read ×3');
    expect(top).toContain('✗1');
    expect(top.match(/─/g)).toHaveLength(1);
    expect(displayWidth(bottom)).toBe(80);
  });

  it('shows the useful argument detail for every grouped call', () => {
    const data: ToolGroupData = {
      name: 'codebase-search',
      totalDurationMs: 18,
      okCount: 3,
      failCount: 0,
      entries: [
        {
          id: 1,
          kind: 'tool',
          name: 'codebase-search',
          durationMs: 5,
          ok: true,
          input: { query: 'tool grouping', kind: 'function' },
        },
        {
          id: 2,
          kind: 'tool',
          name: 'codebase-search',
          durationMs: 6,
          ok: true,
          input: { query: 'history renderer', lang: 'ts' },
        },
        {
          id: 3,
          kind: 'tool',
          name: 'codebase-search',
          durationMs: 7,
          ok: true,
          input: { query: 'format arguments', file: 'packages/tui/src/components/history' },
        },
      ],
    };

    const { lastFrame, unmount } = render(React.createElement(ToolGroup, { data, termWidth: 100 }));
    const frame = lastFrame() ?? '';
    unmount();

    expect(frame).toContain('codebase-search ×3');
    expect(frame).toContain('"tool grouping" · function');
    expect(frame).toContain('"history renderer" · ts');
    expect(frame).toContain('"format arguments" · in');
  });

  it('uses the generic argument fallback for grouped extension tools', () => {
    const data: ToolGroupData = {
      name: 'custom-tool',
      totalDurationMs: 2,
      okCount: 2,
      failCount: 0,
      entries: [
        {
          id: 1,
          kind: 'tool',
          name: 'custom-tool',
          durationMs: 1,
          ok: true,
          input: { query: 'first custom lookup' },
        },
        {
          id: 2,
          kind: 'tool',
          name: 'custom-tool',
          durationMs: 1,
          ok: true,
          input: { name: 'second target' },
        },
      ],
    };

    const { lastFrame, unmount } = render(React.createElement(ToolGroup, { data, termWidth: 80 }));
    const frame = lastFrame() ?? '';
    unmount();

    expect(frame).toContain('first custom lookup');
    expect(frame).toContain('second target');
  });

  it('keeps replace_file_content and write_to_file as standalone structured diff entries', () => {
    const groups = groupEntries([
      { id: 1, kind: 'tool', name: 'replace_file_content', durationMs: 1, ok: true },
      { id: 2, kind: 'tool', name: 'replace_file_content', durationMs: 1, ok: true },
      { id: 3, kind: 'tool', name: 'write_to_file', durationMs: 1, ok: true },
      { id: 4, kind: 'tool', name: 'write_to_file', durationMs: 1, ok: true },
    ]);
    expect(groups).toHaveLength(4);
    expect(groups.every((g) => g.type === 'single')).toBe(true);
  });
});
