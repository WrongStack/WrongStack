/**
 * Tall-terminal regression tests for the managed history viewport.
 *
 * Reported symptoms (worst on very tall terminals):
 * 1. Blank pages while paging/wheeling through history.
 * 2. Partial rendering — a few items show but the top/bottom of the viewport
 *    stay empty even though more content exists.
 * 3. Everything degrades further after a terminal resize.
 *
 * Root-cause hypothesis under test: the underfill-correction loop mounts at
 * most MAX_UNDERFILL_BUMPS × UNDERFILL_BUMP_ROWS = 128 *estimated* rows of
 * extra content. When estimates exceed actual rendered heights, 128 estimated
 * rows convert to far fewer real rows; a tall viewport's real deficit can
 * exceed that budget and the viewport stays permanently underfilled.
 *
 * The pure-math tests prove the convergence failure without React; the
 * component tests exercise the real Ink pipeline on a tall fake TTY.
 */
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { EntryHeightCache } from '../src/height-cache.js';
import {
  anchorAtTopRow,
  planFromAnchor,
  planPinned,
  type ScrollGeometry,
} from '../src/scroll-anchor.js';
import type { HistoryEntry } from '../src/components/history.js';
import {
  type HistoryScrollController,
  ScrollableHistory,
} from '../src/components/scrollable-history.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

// ── Pure-math convergence proof ─────────────────────────────────────────

/**
 * Simulate the component's measure loop: plan → "measure" mounted groups
 * (promote estimate→actual in the cache) → re-plan with one more bump, up to
 * `maxBumps`. Returns the real rows covered by the final mounted window
 * below the anchor clip.
 */
function simulateMeasureLoop(opts: {
  groupCount: number;
  estimate: number;
  actual: number;
  viewportRows: number;
  maxBumps: number;
  bumpRows: number;
  pinned: boolean;
}): { visibleRealRows: number; bumpsUsed: number } {
  const { groupCount, estimate, actual, viewportRows, maxBumps, bumpRows, pinned } = opts;
  const ids = Array.from({ length: groupCount }, (_, i) => i + 1);
  const cache = new EntryHeightCache();
  cache.sync(ids, estimate);
  const geometry: ScrollGeometry = { cache, groupCount, viewportRows, tailRows: 0 };

  const measured = new Set<number>();
  let bump = 0;
  for (;;) {
    const anchor = pinned ? null : anchorAtTopRow(geometry, 0);
    const plan =
      anchor !== null
        ? planFromAnchor(geometry, anchor, bump * bumpRows)
        : planPinned(geometry, bump * bumpRows);
    // "Measure" every mounted group: its real height replaces the estimate.
    for (let i = plan.startIdx; i < plan.endIdx; i++) {
      const id = ids[i]!;
      if (!measured.has(id)) {
        measured.add(id);
        cache.record(id, actual);
      }
    }
    // Recompute the real rows the mounted window covers (mirrors the
    // component's visibleBudget check — all mounted groups are now measured).
    const startTop = cache.accumulatedHeight(plan.startIdx);
    const mountedRows = cache.accumulatedHeight(plan.endIdx) - startTop;
    const clip = anchor?.clip ?? 0;
    const visible = mountedRows - clip;
    const exhausted = pinned ? plan.startIdx <= 0 : plan.endIdx >= groupCount;
    if (visible >= viewportRows || exhausted || bump >= maxBumps) {
      return { visibleRealRows: visible, bumpsUsed: bump };
    }
    bump++;
  }
}

describe('underfill convergence math (tall viewport, overestimated groups)', () => {
  // 300 groups, estimated 8 rows each but really 2 rows: a 4× overestimate,
  // as happens with markdown-heavy or diff-preview entries after a resize
  // resets measurements back to estimates.
  const CASE = { groupCount: 300, estimate: 8, actual: 2 };

  it('a scrolled anchor on a 100-row viewport converges within the bump cap', () => {
    const { visibleRealRows } = simulateMeasureLoop({
      ...CASE,
      viewportRows: 100,
      maxBumps: 8,
      bumpRows: 16,
      pinned: false,
    });
    // Content is plentiful (300×2 = 600 real rows); the viewport must fill.
    expect(visibleRealRows).toBeGreaterThanOrEqual(100);
  });

  it('a pinned tall viewport converges within the bump cap', () => {
    const { visibleRealRows } = simulateMeasureLoop({
      ...CASE,
      viewportRows: 100,
      maxBumps: 8,
      bumpRows: 16,
      pinned: true,
    });
    expect(visibleRealRows).toBeGreaterThanOrEqual(100);
  });
});

// ── Component-level tests on a tall fake TTY ────────────────────────────

/** Mixed-height markdown entries — the same shape the lurch-proof test uses,
 *  but with heavier markdown so estimates diverge from rendered heights. */
function makeEntries(count: number): HistoryEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    const tall = i % 3 === 0;
    const text = tall
      ? `M${n} heading\n\n\`\`\`\ncode a\ncode b\ncode c\ncode d\n\`\`\`\ntrailer for M${n}`
      : `M${n} **short** *line* with [a link](https://example.com/${n}) and \`code\``;
    return { id: i + 1, kind: 'assistant', text } as HistoryEntry;
  });
}

/** Rows in the viewport band that contain any non-whitespace content. */
function contentRowCount(lines: string[], viewportRows: number): number {
  return lines.slice(0, viewportRows).filter((l) => l.trim().length > 0).length;
}

/** Largest run of consecutive blank lines strictly inside the viewport band. */
function maxBlankRun(lines: string[], viewportRows: number): number {
  let run = 0;
  let max = 0;
  for (const line of lines.slice(0, viewportRows)) {
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

describe('ScrollableHistory on a tall terminal', () => {
  const COLS = 100;

  it('fills a 90-row pinned viewport (no hole above the newest output)', async () => {
    const VP = 90;
    const entries = makeEntries(120);
    const controllerRef = createRef<HistoryScrollController>();
    const tty = renderRealTty(view(entries, VP, controllerRef), { columns: COLS, rows: VP + 4 });
    await settle(120);

    const lines = tty.lines();
    // 120 mixed entries far exceed 90 rows, so every viewport row must show
    // content (blank separator lines inside markdown are fine, holes are not).
    expect(contentRowCount(lines, VP)).toBeGreaterThan(VP - 8);
    expect(maxBlankRun(lines, VP)).toBeLessThanOrEqual(2);
    tty.unmount();
  });

  it('paging up through history never yields a blank page', async () => {
    const VP = 90;
    const entries = makeEntries(120);
    const controllerRef = createRef<HistoryScrollController>();
    const tty = renderRealTty(view(entries, VP, controllerRef), { columns: COLS, rows: VP + 4 });
    await settle(120);

    for (let page = 0; page < 6; page++) {
      controllerRef.current?.scrollPage('up');
      await settle(120);
      const lines = tty.lines();
      expect(
        contentRowCount(lines, VP),
        `page-up #${page + 1}: viewport should stay full`,
      ).toBeGreaterThan(VP - 8);
      expect(maxBlankRun(lines, VP), `page-up #${page + 1}: no blank hole`).toBeLessThanOrEqual(2);
    }
    tty.unmount();
  });

  it('scrollToTop on a tall viewport shows the oldest entries with a full page', async () => {
    const VP = 90;
    const entries = makeEntries(120);
    const controllerRef = createRef<HistoryScrollController>();
    const tty = renderRealTty(view(entries, VP, controllerRef), { columns: COLS, rows: VP + 4 });
    await settle(120);

    controllerRef.current?.scrollToTop();
    await settle(120);
    const lines = tty.lines();
    expect(lines.join('\n')).toContain('M001');
    expect(contentRowCount(lines, VP)).toBeGreaterThan(VP - 8);
    tty.unmount();
  });

  it('growing the viewport (24 → 90 rows) refills it', async () => {
    const entries = makeEntries(120);
    const controllerRef = createRef<HistoryScrollController>();
    // Start small — like a terminal before the user maximizes it.
    const tty = renderRealTty(view(entries, 24, controllerRef), { columns: COLS, rows: 96 });
    await settle(120);

    // Scroll away from pinned so the anchored path is exercised too.
    controllerRef.current?.scrollPage('up');
    await settle(120);

    // Resize: the app recomputes viewportRows and re-renders.
    tty.rerender(view(entries, 90, controllerRef));
    await settle(160);

    const lines = tty.lines();
    expect(contentRowCount(lines, 90)).toBeGreaterThan(82);
    expect(maxBlankRun(lines, 90)).toBeLessThanOrEqual(2);
    tty.unmount();
  });
});
