import React from 'react';
import { describe, expect, it } from 'vitest';
import { layoutRail, type RailSpan, type RailSpanEntry } from '../src/components/powerline-rail.js';
import {
  fmtElapsed,
  hasTokenDisplay,
  renderMeter,
  renderProgress,
  stateChip,
  tokenDisplayTotals,
} from '../src/components/status-bar.js';
import { fmtMemory } from '../src/components/status-bar-format.js';
import { Text } from '../src/ink.js';
import { theme } from '../src/theme.js';

function chip(text: string): React.ReactElement {
  return React.createElement(Text, null, text);
}

/**
 * The 0-based column spans the renderer will actually keep.
 *
 * `layoutRail` returns each surviving chip WITH its node; the status bar's
 * click-map builder projects that down to `{id,start,len,level}` from the
 * same single layout pass. These tests assert that geometry, so they apply
 * the same projection locally rather than through a production shim: a
 * shim existed for exactly this and became unreachable when the click map
 * moved onto `layoutRail` directly, leaving a tested-but-uncalled export.
 */
function railSpans(
  entries: readonly RailSpanEntry[],
  budget: number,
  rightAnchor?: React.ReactElement | null,
): RailSpan[] {
  return layoutRail(entries, budget, rightAnchor).items.map(({ id, start, len, level }) => ({
    id,
    start,
    len,
    level,
  }));
}

describe('rail span projection (hit-test geometry)', () => {
  it('lays segments out 0-based with 2-space separators, mirroring PowerlineRail', () => {
    const spans = railSpans(
      [
        { id: 'yolo', node: chip('YOLO') },
        { id: 'model', node: chip('openai/gpt-5.6') },
        { id: 'state', node: chip('idle') },
      ],
      120,
    );
    expect(spans).toEqual([
      { id: 'yolo', start: 0, len: 4, level: 0 },
      { id: 'model', start: 6, len: 'openai/gpt-5.6'.length, level: 0 },
      { id: 'state', start: 6 + 'openai/gpt-5.6'.length + 2, len: 4, level: 0 },
    ]);
  });

  it('drops segments that exceed the budget exactly like the renderer', () => {
    const spans = railSpans(
      [
        { id: 'a', node: chip('aaaaaaaaaa') },
        { id: 'b', node: chip('bbbbbbbbbb') },
        { id: 'c', node: chip('cccccccccc') },
      ],
      // Only the first two fit once the `+N` omission marker is reserved.
      26,
    );
    expect(spans.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('always keeps the first segment even when over budget', () => {
    const spans = railSpans([{ id: 'a', node: chip('aaaaaaaaaa') }], 4);
    expect(spans).toEqual([{ id: 'a', start: 0, len: 10, level: 0 }]);
  });

  it('trims trailing segments to make room for a right anchor', () => {
    const anchor = chip('v9.9.99');
    const withAnchor = railSpans(
      [
        { id: 'a', node: chip('aaaaaaaaaa') },
        { id: 'b', node: chip('bbbbbbbbbb') },
      ],
      24,
      anchor,
    );
    expect(withAnchor.map((s) => s.id)).toEqual(['a']);
    const withoutAnchor = railSpans(
      [
        { id: 'a', node: chip('aaaaaaaaaa') },
        { id: 'b', node: chip('bbbbbbbbbb') },
      ],
      24,
    );
    expect(withoutAnchor.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('returns no spans for an empty rail', () => {
    expect(railSpans([], 80)).toEqual([]);
  });

  it('shortens the widest chip before it drops any chip', () => {
    const spans = railSpans(
      [
        { id: 'fat', node: chip('a'.repeat(40)), alt: [chip('a'.repeat(8))] },
        { id: 'thin', node: chip('bbbb') },
      ],
      30,
    );
    // Both survive: the fitter concedes detail, not chips.
    expect(spans.map((s) => s.id)).toEqual(['fat', 'thin']);
    expect(spans[0]!.level).toBe(1);
    expect(spans[0]!.len).toBe(8);
  });

  it('drops only once every chip is at its narrowest level', () => {
    const spans = railSpans(
      [
        { id: 'a', node: chip('a'.repeat(20)), alt: [chip('aaaaa')] },
        { id: 'b', node: chip('b'.repeat(20)), alt: [chip('bbbbb')] },
        { id: 'c', node: chip('c'.repeat(20)), alt: [chip('ccccc')] },
      ],
      14,
    );
    expect(spans.map((s) => s.id)).toEqual(['a']);
    expect(spans[0]!.level).toBe(1);
  });

  it('honours a pinned density: a chip with lo===hi never degrades', () => {
    const spans = railSpans(
      [
        { id: 'pinned', node: chip('P'.repeat(20)), alt: [chip('P')], lo: 0, hi: 0 },
        { id: 'free', node: chip('f'.repeat(20)), alt: [chip('f')] },
      ],
      24,
    );
    expect(spans[0]!.level).toBe(0);
    expect(spans[0]!.len).toBe(20);
    expect(spans[1]!.level).toBe(1);
  });
});

describe('fmtElapsed', () => {
  it('renders mm:ss under one hour', () => {
    expect(fmtElapsed(0)).toBe('00:00');
    expect(fmtElapsed(5_000)).toBe('00:05');
    expect(fmtElapsed(65_000)).toBe('01:05');
    expect(fmtElapsed(59 * 60_000 + 30_000)).toBe('59:30');
  });

  it('switches to h:mm:ss at exactly one hour', () => {
    expect(fmtElapsed(60 * 60_000)).toBe('1:00:00');
    expect(fmtElapsed(60 * 60_000 + 1_000)).toBe('1:00:01');
    expect(fmtElapsed(3 * 60 * 60_000 + 15 * 60_000 + 7_000)).toBe('3:15:07');
  });

  it('rounds milliseconds down (floor)', () => {
    expect(fmtElapsed(999)).toBe('00:00');
    expect(fmtElapsed(1_999)).toBe('00:01');
  });

  it('pads seconds and minutes with leading zeros under an hour', () => {
    expect(fmtElapsed(3_000)).toBe('00:03');
    expect(fmtElapsed(63_000)).toBe('01:03');
  });
});

describe('fmtMemory', () => {
  it('uses compact binary units for process memory chips', () => {
    expect(fmtMemory(512 * 1024)).toBe('512K');
    expect(fmtMemory(768 * 1024 * 1024)).toBe('768M');
    expect(fmtMemory(1.5 * 1024 * 1024 * 1024)).toBe('1.5G');
  });
});

describe('stateChip', () => {
  it('shows plain idle when no background agents are running', () => {
    expect(stateChip('idle', 0)).toEqual({ label: 'idle', color: theme.accent });
  });

  it('surfaces the live agent count when idle but background agents run', () => {
    expect(stateChip('idle', 1)).toEqual({ label: 'agents ▶1', color: theme.monitor.agents });
    expect(stateChip('idle', 3)).toEqual({ label: 'agents ▶3', color: theme.monitor.agents });
  });

  it('keeps foreground states regardless of fleet count', () => {
    // A running/streaming foreground already implies activity — the chip
    // reflects the foreground, not the background fleet.
    expect(stateChip('running', 5)).toEqual({ label: 'thinking…', color: theme.success });
    expect(stateChip('streaming', 5)).toEqual({ label: 'thinking…', color: theme.success });
    expect(stateChip('aborting', 5)).toEqual({ label: 'aborting…', color: theme.warn });
  });

  it('uses a configured single-word foreground label', () => {
    expect(stateChip('running', 0, 'working')).toEqual({ label: 'working…', color: theme.success });
  });

  it('falls back to thinking for invalid configured words', () => {
    expect(stateChip('running', 0, 'two words')).toEqual({
      label: 'thinking…',
      color: theme.success,
    });
    expect(stateChip('running', 0, 'x'.repeat(17))).toEqual({
      label: 'thinking…',
      color: theme.success,
    });
  });
});

describe('renderProgress', () => {
  it('renders an empty bar at ratio 0', () => {
    expect(renderProgress(0, 10)).toBe('░░░░░░░░░░');
  });

  it('renders a full bar at ratio 1', () => {
    expect(renderProgress(1, 10)).toBe('██████████');
  });

  it('shows at least one filled cell for any non-zero ratio (so 1% != 0%)', () => {
    const bar = renderProgress(0.01, 10);
    expect(bar.startsWith('█')).toBe(true);
    expect(bar.length).toBe(10);
  });

  it('rounds 50% to 5 of 10 cells', () => {
    expect(renderProgress(0.5, 10)).toBe('█████░░░░░');
  });

  it('clamps ratios outside [0,1]', () => {
    expect(renderProgress(-0.5, 8)).toBe('░░░░░░░░');
    expect(renderProgress(1.7, 8)).toBe('████████');
  });

  it('keeps total width stable across all ratios', () => {
    for (let i = 0; i <= 10; i++) {
      expect(renderProgress(i / 10, 12).length).toBe(12);
    }
  });
});

describe('renderMeter (bracket-style)', () => {
  it('is empty at 0 and full at 1', () => {
    expect(renderMeter(0, 10)).toBe('[o.........]');
    expect(renderMeter(1, 10)).toBe('[0000000000]');
  });

  it('keeps total visual width stable across all ratios', () => {
    for (let i = 0; i <= 24; i++) {
      // Brackets add 2 chars: `[` + width cells + `]`
      expect([...renderMeter(i / 24, 12)].length).toBe(14);
    }
  });

  it('renders a fractional leading cell instead of jumping a whole cell', () => {
    // 1/24 × 12 cells = 0.5 → rounded to 1 filled cell
    const bar = renderMeter(1 / 12 / 2, 12);
    expect(bar).toBe('[0o..........]');
  });

  it('clamps out-of-range ratios', () => {
    expect(renderMeter(-1, 8)).toBe('[o.......]');
    expect(renderMeter(2, 8)).toBe('[00000000]');
  });
});

describe('tokenDisplayTotals', () => {
  it('falls back to current request input tokens when provider usage totals are zero', () => {
    expect(
      tokenDisplayTotals({ input: 0, output: 0 }, { input: 3210, cacheRead: 40, cacheWrite: 10 }),
    ).toEqual({
      input: 3260,
      output: 0,
    });
  });

  it('prefers accounted provider usage once it is available', () => {
    expect(
      tokenDisplayTotals(
        { input: 1000, output: 200, cacheRead: 300, cacheWrite: 400 },
        { input: 3210, cacheRead: 40, cacheWrite: 10 },
      ),
    ).toEqual({ input: 1700, output: 200 });
  });

  it('marks the token chip visible when only outgoing request tokens exist', () => {
    expect(
      hasTokenDisplay(
        tokenDisplayTotals(undefined, { input: 3210, cacheRead: 40, cacheWrite: 10 }),
      ),
    ).toBe(true);
  });

  it('keeps the token chip hidden when no input or output tokens exist', () => {
    expect(hasTokenDisplay(tokenDisplayTotals({ input: 0, output: 0 }, undefined))).toBe(false);
  });

  it('falls back to the local estimate when provider AND current-request tokens are zero', () => {
    // A provider that reports no prompt usage would otherwise leave "↑" at 0
    // even though we clearly sent a request — use the local breakdown estimate.
    expect(tokenDisplayTotals({ input: 0, output: 0 }, undefined, 48_500)).toEqual({
      input: 48_500,
      output: 0,
    });
    expect(hasTokenDisplay(tokenDisplayTotals({ input: 0, output: 0 }, undefined, 48_500))).toBe(
      true,
    );
  });

  it('ignores the local estimate once the provider reports real usage', () => {
    expect(tokenDisplayTotals({ input: 1000, output: 200 }, undefined, 48_500)).toEqual({
      input: 1000,
      output: 200,
    });
  });
});
