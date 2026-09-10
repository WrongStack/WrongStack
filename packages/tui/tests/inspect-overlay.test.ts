import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import { LIVE_TOOL_STREAM_COPY_ID } from '../src/components/history/copy-geometry.js';
import {
  inspectTextForEntry,
  inspectTitleForEntries,
} from '../src/components/history/copy-icon.js';
import { EMPTY_KEY } from '../src/components/input.js';
import {
  INSPECT_OVERLAY_MIN_ROWS,
  InspectOverlay,
  inspectOverlayHeaderActionAt,
  inspectOverlaySize,
  resolveInspectOverlayContent,
  scrollbarThumbGeometry,
  wrapInspectLines,
} from '../src/components/inspect-overlay.js';
import type { HistoryEntry } from '../src/history-entry.js';
import { routeModalOverlayKey } from '../src/overlay-key-router.js';
import { createTestState } from './helpers/create-test-state.js';

const tool = (
  id: number,
  name: string,
  output: string,
  extra: Partial<Extract<HistoryEntry, { kind: 'tool' }>> = {},
): HistoryEntry => ({
  id,
  kind: 'tool',
  name,
  durationMs: 12,
  ok: true,
  input: { path: 'a.ts' },
  output,
  copyOutput: extra.copyOutput ?? output,
  ...extra,
});

describe('inspect overlay payload', () => {
  it('keeps the full untruncated tool result and input', () => {
    const entry = tool(1, 'read', 'line\n'.repeat(80), {
      copyOutput: 'canonical-full-output',
      outputBytes: 21,
    });
    const text = inspectTextForEntry(entry);
    expect(text).toContain('read  ok · 12ms · 21B');
    expect(text).toContain('INPUT');
    expect(text).toContain('"path": "a.ts"');
    expect(text).toContain('OUTPUT');
    expect(text).toContain('canonical-full-output');
    expect(inspectTitleForEntries([entry])).toBe('read');
  });

  it('titles grouped tools compactly', () => {
    expect(inspectTitleForEntries([tool(1, 'read', 'a'), tool(2, 'read', 'b')])).toBe('read × 2');
    expect(inspectTitleForEntries([tool(1, 'read', 'a'), tool(2, 'grep', 'b')])).toBe('2 tools');
  });

  it('resolves live stream and missing history', () => {
    expect(
      resolveInspectOverlayContent({ entryId: LIVE_TOOL_STREAM_COPY_ID }, [], {
        name: 'bash',
        text: 'partial',
      }),
    ).toEqual({ title: 'bash  streaming', body: 'partial' });
    expect(resolveInspectOverlayContent({ entryId: 99 }, [], null)).toEqual({
      title: 'Inspect',
      body: '(entry is no longer in history)',
    });
  });
});

describe('inspect overlay geometry', () => {
  it('wraps long lines and keeps a centered card at least 15 rows on a tall viewport', () => {
    expect(wrapInspectLines('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    const size = inspectOverlaySize(100, 40);
    expect(size.width).toBeGreaterThanOrEqual(40);
    expect(size.height).toBeGreaterThanOrEqual(INSPECT_OVERLAY_MIN_ROWS);
    expect(size.height).toBeLessThanOrEqual(40);
  });

  it('hit-tests the Copy and Close controls on the centered title row', () => {
    expect(inspectOverlayHeaderActionAt(80, 24, 65, 4)).toBe('copy');
    expect(inspectOverlayHeaderActionAt(80, 24, 74, 4)).toBe('close');
    expect(inspectOverlayHeaderActionAt(80, 24, 65, 5)).toBeNull();
  });
});

describe('inspect overlay reducer', () => {
  it('opens, scrolls, and closes the overlay', () => {
    const opened = reducer(createTestState(), {
      type: 'inspectOverlayOpen',
      entryId: 7,
      entryIds: [7, 8],
    });
    expect(opened.inspectOverlay).toEqual({ entryId: 7, entryIds: [7, 8], scroll: 0 });

    const scrolled = reducer(opened, { type: 'inspectOverlayScroll', delta: 3 });
    expect(scrolled.inspectOverlay?.scroll).toBe(3);

    const clamped = reducer(scrolled, { type: 'inspectOverlayScroll', delta: -100 });
    expect(clamped.inspectOverlay?.scroll).toBe(0);

    const closed = reducer(scrolled, { type: 'inspectOverlayClose' });
    expect(closed.inspectOverlay).toBeNull();
  });
});

describe('inspect overlay render', () => {
  it('shows the tool title, full body, and title-bar controls', () => {
    const view = render(
      React.createElement(InspectOverlay, {
        title: 'read',
        body: 'full file contents here',
        scroll: 0,
        termCols: 80,
        viewportRows: 24,
        onScroll: () => undefined,
        onClose: () => undefined,
      }),
    );
    const frame = view.lastFrame() ?? '';
    view.unmount();
    expect(frame).toContain('read');
    expect(frame).toContain('full file contents here');
    expect(frame).toContain('[Copy] [Close]');
  });

  it('routes title-bar clicks to copy and close without dropping Esc support', () => {
    const state = createTestState({
      inspectOverlay: { entryId: 7, scroll: 0 },
    });
    const dispatch = vi.fn();
    const copyInspectOverlay = vi.fn();
    const route = (x: number, y: number) =>
      routeModalOverlayKey(
        {
          state,
          enhanceCancelled: { current: false },
          enhanceController: { current: null },
          inspectGeometry: { termCols: 80, viewportRows: 24 },
          dispatch,
          copyInspectOverlay,
        },
        '',
        {
          ...EMPTY_KEY,
          mouse: {
            kind: 'press',
            button: 'left',
            x,
            y,
            wheel: 0,
            shift: false,
            meta: false,
            ctrl: false,
            motion: false,
          },
        },
      );

    expect(route(65, 4)).toBe(true);
    expect(copyInspectOverlay).toHaveBeenCalledTimes(1);
    expect(route(74, 4)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: 'inspectOverlayClose' });

    routeModalOverlayKey(
      {
        state,
        enhanceCancelled: { current: false },
        enhanceController: { current: null },
        dispatch,
      },
      '',
      { ...EMPTY_KEY, escape: true },
    );
    expect(dispatch).toHaveBeenCalledWith({ type: 'inspectOverlayClose' });
  });
});

describe('inspect overlay scrollbar geometry', () => {
  it('covers the whole track when the wrapped body fits', () => {
    expect(scrollbarThumbGeometry(10, 16, 0)).toEqual({ thumbStart: 0, thumbLength: 16 });
  });

  it('sizes the thumb proportionally and travels to flush bottom at max scroll', () => {
    // 30 wrapped lines with 10 visible rows → thumb 1/3 of the track, 7 rows of travel.
    expect(scrollbarThumbGeometry(30, 10, 0)).toEqual({ thumbStart: 0, thumbLength: 3 });
    expect(scrollbarThumbGeometry(30, 10, 20)).toEqual({ thumbStart: 7, thumbLength: 3 });
    // Very long body keeps a one-row thumb that pins to the last track row.
    expect(scrollbarThumbGeometry(100, 10, 0)).toEqual({ thumbStart: 0, thumbLength: 1 });
    expect(scrollbarThumbGeometry(100, 10, 90)).toEqual({ thumbStart: 9, thumbLength: 1 });
  });

  it('clamps out-of-range offsets', () => {
    expect(scrollbarThumbGeometry(100, 10, -5).thumbStart).toBe(0);
    expect(scrollbarThumbGeometry(100, 10, 999)).toEqual({ thumbStart: 9, thumbLength: 1 });
  });

  it('renders a scrollbar gutter for overflowing content', () => {
    const view = render(
      React.createElement(InspectOverlay, {
        title: 'bash',
        body: Array.from({ length: 60 }, (_, i) => `line-${i}`).join('\n'),
        scroll: 0,
        termCols: 80,
        viewportRows: 24,
        onScroll: () => undefined,
        onClose: () => undefined,
      }),
    );
    const frame = view.lastFrame() ?? '';
    view.unmount();
    expect(frame).toContain('░'); // track glyph
    expect(frame).toContain('█'); // thumb at the top for scroll 0
  });
});
