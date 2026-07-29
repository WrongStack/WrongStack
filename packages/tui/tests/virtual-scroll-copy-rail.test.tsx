import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { COPY_ICON } from '../src/components/history/copy-icon.js';
import { groupEntries, renderGroupId } from '../src/components/history/tool-group.js';
import type { HistoryEntry } from '../src/components/history.js';
import {
  type HistoryScrollController,
  ScrollableHistory,
} from '../src/components/scrollable-history.js';
import { SCROLLBAR_HIT_WIDTH } from '../src/hit-test.js';
import { LayoutStore } from '../src/layout-store.js';
import { cleanFrame, renderRealTty, settle } from './helpers/real-tty.js';

function toolHeavyEntries(turns: number): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  let id = 1;
  for (let index = 0; index < turns; index++) {
    const marker = String(index + 1).padStart(3, '0');
    entries.push({
      id: id++,
      kind: 'assistant',
      text:
        `H${marker} ${'width-sensitive prose '.repeat(5)}\n\n` + `${'second paragraph '.repeat(6)}`,
    });
    entries.push({
      id: id++,
      kind: 'tool',
      name: index % 2 === 0 ? 'codebase-search' : 'shell',
      input: {
        query: `T${marker} ${'copy gutter boundary '.repeat(4)}`,
      },
      output: `T${marker}\n${Array.from(
        { length: 5 },
        (_, line) => `output ${line} ${'x'.repeat(70)}`,
      ).join('\n')}`,
      ok: true,
      durationMs: index,
    });
    if (index % 3 === 0) {
      // Consecutive same-name calls exercise the compact tool-group path that
      // gained a copy gutter in the regressing change.
      entries.push({
        id: id++,
        kind: 'tool',
        name: 'codebase-search',
        input: {
          query: `T${marker}-group ${'second grouped call '.repeat(4)}`,
        },
        output: `T${marker}-group output`,
        ok: true,
        durationMs: index + 1,
      });
    }
  }
  return entries;
}

function maxHistoryBlankRun(frame: string, viewportRows: number): number {
  let run = 0;
  let max = 0;
  for (const line of cleanFrame(frame).split('\n').slice(0, viewportRows)) {
    // Remove both UI-owned right-edge regions. A copy glyph or scrollbar track
    // must never make an otherwise empty chat row count as populated.
    const history = line.slice(0, -SCROLLBAR_HIT_WIDTH);
    if (history.trim().length === 0) {
      run++;
      max = Math.max(max, run);
    } else {
      run = 0;
    }
  }
  return max;
}

function visibleAssistantMarkers(frame: string): number[] {
  return [...cleanFrame(frame).matchAll(/H(\d{3})/g)].map((match) => Number(match[1]));
}

describe('virtual scroll copy rail geometry', () => {
  it('keeps copy icons outside the width used by estimates, measurements, and cache rows', async () => {
    const columns = 84;
    const viewportRows = 36;
    const entries = toolHeavyEntries(30);
    const groups = groupEntries(entries);
    expect(groups.some((group) => group.type === 'tool-group')).toBe(true);
    const layoutStore = new LayoutStore({
      sessionDataDir: undefined,
      ephemeral: true,
    });
    const controllerRef = createRef<HistoryScrollController>();
    const tty = renderRealTty(
      <ScrollableHistory
        entries={entries}
        toolStream={null}
        viewportRows={viewportRows}
        controllerRef={controllerRef}
        layoutStore={layoutStore}
      />,
      { columns, rows: viewportRows + 4 },
    );

    await settle(350);

    const expectedLayoutWidth = columns - SCROLLBAR_HIT_WIDTH;
    expect(layoutStore.termWidth).toBe(expectedLayoutWidth);
    let measuredGroups = 0;
    for (const group of groups) {
      const layout = layoutStore.get(renderGroupId(group));
      expect(layout?.termWidth).toBe(expectedLayoutWidth);
      if (layout?.kind === 'measured') measuredGroups++;
    }
    // True virtualization measures only the mounted window. The old global
    // calibration pass mounted the entire transcript once and made this test
    // pass at the cost of a giant first-frame layout.
    expect(measuredGroups).toBeGreaterThan(0);
    expect(measuredGroups).toBeLessThan(groups.length);
    expect(tty.lastFrame()).toMatch(/❏[│█]$/m);
    const lines = tty.lines();
    for (const line of lines) {
      expect(line.slice(0, -SCROLLBAR_HIT_WIDTH)).not.toContain(COPY_ICON);
    }
    const iconRow = lines.findIndex((line) => /❏[│█]$/.test(line));
    expect(iconRow).toBeGreaterThanOrEqual(0);
    expect(controllerRef.current?.hasCopyTargetAt(iconRow, expectedLayoutWidth)).toBe(true);
    expect(controllerRef.current?.hasCopyTargetAt(iconRow, expectedLayoutWidth + 1)).toBe(false);
    tty.unmount();
  });

  it('keeps tool-heavy wheel frames filled and marker order monotonic', async () => {
    const columns = 84;
    const viewportRows = 42;
    const entries = toolHeavyEntries(80);
    const controllerRef = createRef<HistoryScrollController>();
    const tty = renderRealTty(
      <ScrollableHistory
        entries={entries}
        toolStream={null}
        viewportRows={viewportRows}
        controllerRef={controllerRef}
      />,
      { columns, rows: viewportRows + 4 },
    );

    await settle(350);
    controllerRef.current?.scrollToTop();
    await settle(150);

    let previousFirstMarker = 0;
    for (let step = 0; step < 45 && controllerRef.current?.isScrolled(); step++) {
      const frameStart = tty.stdout.frames.length;
      controllerRef.current?.scrollBy(-4);
      await settle(20);

      for (const frame of tty.stdout.frames.slice(frameStart)) {
        expect(
          maxHistoryBlankRun(frame, viewportRows),
          `wheel step ${step + 1} emitted an empty history band`,
        ).toBeLessThanOrEqual(2);
      }

      const markers = visibleAssistantMarkers(tty.stdout.frames.at(-1) ?? '');
      expect(markers.length, `wheel step ${step + 1} lost all history markers`).toBeGreaterThan(0);
      expect(markers).toEqual([...markers].sort((left, right) => left - right));
      const firstMarker = markers[0] ?? previousFirstMarker;
      expect(
        firstMarker,
        `wheel step ${step + 1} jumped back to unrelated older content`,
      ).toBeGreaterThanOrEqual(previousFirstMarker);
      previousFirstMarker = firstMarker;
    }

    expect(previousFirstMarker).toBeGreaterThan(0);
    tty.unmount();
  }, 30_000);

  it('maps scrollbar track positions monotonically to the matching content region', async () => {
    const columns = 84;
    const viewportRows = 42;
    const entries = toolHeavyEntries(80);
    const controllerRef = createRef<HistoryScrollController>();
    const tty = renderRealTty(
      <ScrollableHistory
        entries={entries}
        toolStream={null}
        viewportRows={viewportRows}
        controllerRef={controllerRef}
      />,
      { columns, rows: viewportRows + 4 },
    );

    await settle(350);
    const firstMarkers: number[] = [];
    for (const cell of [
      0,
      Math.floor(viewportRows * 0.25),
      Math.floor(viewportRows * 0.5),
      Math.floor(viewportRows * 0.75),
      viewportRows - 1,
    ]) {
      const frameStart = tty.stdout.frames.length;
      controllerRef.current?.scrollToTrackCell(cell);
      await settle(120);
      for (const frame of tty.stdout.frames.slice(frameStart)) {
        expect(maxHistoryBlankRun(frame, viewportRows)).toBeLessThanOrEqual(2);
      }
      const marker = visibleAssistantMarkers(tty.stdout.frames.at(-1) ?? '')[0];
      expect(marker, `track cell ${cell} lost the target content region`).toBeDefined();
      firstMarkers.push(marker ?? 0);
    }

    expect(firstMarkers).toEqual([...firstMarkers].sort((left, right) => left - right));
    expect(firstMarkers[0]).toBeLessThanOrEqual(3);
    expect(firstMarkers.at(-1)).toBeGreaterThanOrEqual(70);
    tty.unmount();
  }, 30_000);
});
