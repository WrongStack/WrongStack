/**
 * Underfill-bump starvation on tall terminals.
 *
 * The measure pass corrects underfill by mounting `mountBump ×
 * UNDERFILL_BUMP_ROWS` extra *estimated* rows, capped at MAX_UNDERFILL_BUMPS.
 * When an entry's estimate is much larger than its rendered height (markdown
 * collapses consecutive blank lines, so a 150-blank-line entry estimated at
 * ~150 rows renders as ~2), the entire correction budget (8 × 16 = 128
 * estimated rows) converts to a handful of real rows. A tall viewport then
 * NEVER fills: pinned mode leaves a permanent hole above the content
 * (flex-end), scrolled mode leaves the bottom of the viewport empty — exactly
 * the reported "few items show but top/bottom stay blank" symptom, which is
 * invisible on short terminals and crippling on tall ones.
 */
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../src/components/history.js';
import {
  type HistoryScrollController,
  ScrollableHistory,
} from '../src/components/scrollable-history.js';
import { cleanFrame, renderRealTty, settle } from './helpers/real-tty.js';

/** Entries whose raw line count (≈ estimate) vastly exceeds rendered rows:
 *  markdown collapses the blank-line run to a single paragraph break. */
function makeCollapsingEntries(count: number): HistoryEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    const text = `M${n} first line${'\n'.repeat(120)}M${n} last line`;
    return { id: i + 1, kind: 'assistant', text } as HistoryEntry;
  });
}

function contentRowCount(lines: string[], viewportRows: number): number {
  return (
    lines
      .slice(0, viewportRows)
      // Strip trailing Ink frame-padding chars that survive cleanFrame
      .filter((line) => line.slice(0, -2).trim().length > 0).length
  );
}

function maxHistoryBlankRun(lines: string[], viewportRows: number): number {
  let run = 0;
  let max = 0;
  for (const line of lines.slice(0, viewportRows)) {
    // Strip trailing Ink frame-padding chars that survive cleanFrame
    if (line.slice(0, -2).trim().length === 0) {
      run++;
      max = Math.max(max, run);
    } else {
      run = 0;
    }
  }
  return max;
}

function view(
  entries: HistoryEntry[],
  viewportRows: number,
  controllerRef: { current: HistoryScrollController | null },
) {
  return (
    <ScrollableHistory
      entries={entries}
      toolStream={null}
      viewportRows={viewportRows}
      controllerRef={controllerRef}
    />
  );
}

describe('underfill starvation (estimate ≫ actual)', () => {
  const COLS = 100;

  it('pinned tall viewport fills despite 60:1 overestimated entries', async () => {
    const VP = 120;
    // 100 entries × ~3 real rows ≈ 300 real rows — plenty to fill 120.
    const entries = makeCollapsingEntries(100);
    const controllerRef = createRef<HistoryScrollController>();
    const tty = renderRealTty(view(entries, VP, controllerRef), { columns: COLS, rows: VP + 4 });
    // Generous settle: convergence may take several measure→bump cycles.
    await settle(400);

    const lines = tty.lines();
    expect(
      contentRowCount(lines, VP),
      'pinned viewport should be (nearly) full — permanent top hole means bump starvation',
    ).toBeGreaterThan(VP - 6);
    tty.unmount();
  }, 30_000);

  it('scrolled-to-top tall viewport fills below the anchor', async () => {
    const VP = 120;
    const entries = makeCollapsingEntries(100);
    const controllerRef = createRef<HistoryScrollController>();
    const tty = renderRealTty(view(entries, VP, controllerRef), { columns: COLS, rows: VP + 4 });
    await settle(400);

    controllerRef.current?.scrollToTop();
    await settle(400);

    const lines = tty.lines();
    expect(lines.join('\n')).toContain('M001');
    expect(
      contentRowCount(lines, VP),
      'anchored viewport should be (nearly) full — empty bottom means bump starvation',
    ).toBeGreaterThan(VP - 6);
    tty.unmount();
  }, 30_000);

  it('page-down lands on a full page, not a blank one', async () => {
    const VP = 120;
    const entries = makeCollapsingEntries(100);
    const controllerRef = createRef<HistoryScrollController>();
    const tty = renderRealTty(view(entries, VP, controllerRef), { columns: COLS, rows: VP + 4 });
    await settle(400);

    controllerRef.current?.scrollToTop();
    await settle(300);
    controllerRef.current?.scrollPage('down');
    await settle(400);

    const lines = tty.lines();
    expect(contentRowCount(lines, VP), 'page after PageDown should be full').toBeGreaterThan(
      VP - 6,
    );
    tty.unmount();
  }, 30_000);

  it('never emits an intermediate blank history frame while changing scroll inputs', async () => {
    const VP = 80;
    const entries = makeCollapsingEntries(100);
    const controllerRef = createRef<HistoryScrollController>();
    const tty = renderRealTty(view(entries, VP, controllerRef), {
      columns: COLS,
      rows: VP + 4,
    });
    await settle(300);

    const frameStart = tty.stdout.frames.length;
    controllerRef.current?.scrollToTop();
    await settle(30);
    controllerRef.current?.scrollPage('down');
    await settle(30);
    controllerRef.current?.scrollToTrackCell(Math.floor(VP / 2));
    await settle(30);
    for (let step = 0; step < 15; step++) {
      controllerRef.current?.scrollBy(step % 2 === 0 ? 1 : -1);
      await settle(5);
    }
    await settle(150);

    const interactionFrames = tty.stdout.frames.slice(frameStart);
    expect(interactionFrames.length).toBeGreaterThan(0);
    interactionFrames.forEach((raw, index) => {
      const lines = cleanFrame(raw).split('\n');
      expect(
        maxHistoryBlankRun(lines, VP),
        `interaction frame ${index + 1} contains a blank history band`,
      ).toBeLessThanOrEqual(2);
    });
    tty.unmount();
  }, 30_000);
});
