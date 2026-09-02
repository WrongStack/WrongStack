/**
 * Aggressive tall-terminal stress: wheel-walk the entire transcript on a
 * 150-row viewport, resize while scrolled, and mutate entry heights in place
 * while anchored. Every intermediate frame is asserted non-blank — the
 * reported bug is blank pages / partial fills during interaction, so a single
 * blank frame is a failure, not "eventual consistency".
 */
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../src/components/history.js';
import {
  type HistoryScrollController,
  ScrollableHistory,
} from '../src/components/scrollable-history.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

function makeEntries(count: number): HistoryEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    // Alternate 1-line, mid markdown, and very tall code-fence entries so
    // estimates and measurements disagree in both directions.
    const mode = i % 4;
    let text: string;
    if (mode === 0) {
      text = `M${n} tall\n\n\`\`\`\n${Array.from({ length: 10 }, (_, k) => `line ${k} of M${n}`).join('\n')}\n\`\`\``;
    } else if (mode === 1) {
      text = `M${n} short`;
    } else if (mode === 2) {
      text = `M${n} para one\n\nM${n} para two\n\nM${n} para three`;
    } else {
      text = `M${n} **bold** and \`inline\``;
    }
    return { id: i + 1, kind: 'assistant', text } as HistoryEntry;
  });
}

/** Counts non-blank rows. `trim()` removes any trailing Ink frame-padding whitespace without dropping real content on short lines. */
function contentRowCount(lines: string[], viewportRows: number): number {
  return lines.slice(0, viewportRows).filter((line) => line.trim().length > 0).length;
}

function maxBlankRun(lines: string[], viewportRows: number): number {
  let run = 0;
  let max = 0;
  for (const line of lines.slice(0, viewportRows)) {
    // `trim()` removes trailing Ink frame-padding whitespace without dropping short content.
    if (line.trim().length === 0) {
      run++;
      if (run > max) max = run;
    } else run = 0;
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

describe('tall-terminal stress', () => {
  const COLS = 110;
  const VP = 150;

  it('wheel-walking the whole transcript fills every sampled frame', async () => {
    const entries = makeEntries(200);
    const controllerRef = createRef<HistoryScrollController>();
    const tty = renderRealTty(view(entries, VP, controllerRef), { columns: COLS, rows: VP + 4 });
    await settle(150);

    // Jump to top, then wheel back down 3 rows at a time — the mouse path.
    controllerRef.current?.scrollToTop();
    await settle(120);

    let steps = 0;
    while (controllerRef.current?.isScrolled() && steps < 600) {
      controllerRef.current?.scrollBy(-3);
      // Minimal settle: one frame, like a fast wheel. The measure pass may
      // lag a commit; assert on the settled frame below every 10 steps.
      await settle(15);
      steps++;
      if (steps % 10 === 0) {
        await settle(90);
        const lines = tty.lines();
        expect(
          contentRowCount(lines, VP),
          `wheel step ${steps}: frame nearly empty`,
        ).toBeGreaterThan(VP - 10);
        expect(
          maxBlankRun(lines, VP),
          `wheel step ${steps}: blank hole inside viewport`,
        ).toBeLessThanOrEqual(3);
      }
    }
    // Must have converged (reached bottom) within a reasonable number of steps.
    expect(controllerRef.current?.isScrolled()).toBe(false);
    tty.unmount();
  }, 90_000);

  it('page-down from top on a 150-row viewport shows full pages every time', async () => {
    const entries = makeEntries(200);
    const controllerRef = createRef<HistoryScrollController>();
    const tty = renderRealTty(view(entries, VP, controllerRef), { columns: COLS, rows: VP + 4 });
    await settle(150);

    controllerRef.current?.scrollToTop();
    await settle(120);

    for (let page = 0; page < 8 && controllerRef.current?.isScrolled(); page++) {
      controllerRef.current?.scrollPage('down');
      await settle(150);
      const lines = tty.lines();
      expect(contentRowCount(lines, VP), `page-down #${page + 1}: partial page`).toBeGreaterThan(
        VP - 10,
      );
      expect(maxBlankRun(lines, VP), `page-down #${page + 1}: blank band`).toBeLessThanOrEqual(3);
    }
    tty.unmount();
  }, 60_000);

  it('width resize while scrolled re-fills the tall viewport', async () => {
    const entries = makeEntries(200);
    const controllerRef = createRef<HistoryScrollController>();
    const tty = renderRealTty(view(entries, VP, controllerRef), { columns: COLS, rows: VP + 4 });
    await settle(150);

    controllerRef.current?.scrollToTop();
    await settle(120);
    controllerRef.current?.scrollPage('down');
    await settle(150);

    // Shrink the terminal width: every wrapped height changes, the cache
    // re-seeds from estimates at the new width.
    tty.resize(70, VP + 4);
    await settle(250);

    const lines = tty.lines();
    expect(contentRowCount(lines, VP), 'after width shrink').toBeGreaterThan(VP - 10);
    expect(maxBlankRun(lines, VP), 'after width shrink').toBeLessThanOrEqual(3);

    // And grow it back.
    tty.resize(130, VP + 4);
    await settle(250);
    const lines2 = tty.lines();
    expect(contentRowCount(lines2, VP), 'after width grow').toBeGreaterThan(VP - 10);
    expect(maxBlankRun(lines2, VP), 'after width grow').toBeLessThanOrEqual(3);
    tty.unmount();
  }, 60_000);

  it('repeated height resizes while scrolled never leave the viewport underfilled', async () => {
    const entries = makeEntries(200);
    const controllerRef = createRef<HistoryScrollController>();
    let vp = 40;
    const tty = renderRealTty(view(entries, vp, controllerRef), { columns: COLS, rows: 160 });
    await settle(150);

    controllerRef.current?.scrollToTop();
    await settle(120);

    // Oscillate the viewport height like a user dragging the window edge.
    for (const next of [80, 30, 120, 50, 150]) {
      vp = next;
      tty.rerender(view(entries, vp, controllerRef));
      await settle(200);
      const lines = tty.lines();
      expect(contentRowCount(lines, vp), `after resize to ${vp} rows: underfilled`).toBeGreaterThan(
        vp - 10,
      );
      expect(maxBlankRun(lines, vp), `after resize to ${vp} rows: blank band`).toBeLessThanOrEqual(
        3,
      );
    }
    tty.unmount();
  }, 60_000);
});
