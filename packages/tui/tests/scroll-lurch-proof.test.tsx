import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../src/components/history.js';
import {
  type HistoryScrollController,
  ScrollableHistory,
} from '../src/components/scrollable-history.js';
import { computeLayout } from '../src/layout-engine.js';
import { LayoutStore } from '../src/layout-store.js';
import { type RealTtyView, renderRealTty, settle } from './helpers/real-tty.js';

const VP = 12;

/**
 * Poll until the rendered frame stops changing (bounded quiescence wait).
 *
 * Why not plain `settle()`: on slow Linux CI runners the final Yoga layout
 * correction can land just after `settle()`'s fixed 40ms window, so an
 * assertion reads one in-flight correction frame and frame-equality breaks
 * by exactly one row (the single-row offset signature of the 31811761154
 * flake). Waiting for the frame to go QUIESCENT instead of a fixed duration
 * removes that race: comparisons always read a settled frame.
 *
 * Bounded fallback: if the frame never quiesces within the poll budget the
 * latest frame is returned and the caller's equality assertion fails with a
 * diff — a genuinely unstable render IS the regression this suite hunts.
 */
async function waitForStableFrame(v: RealTtyView, polls = 20, gapMs = 25): Promise<string> {
  // Require N consecutive identical polls before declaring quiescence: a
  // single equal poll can land in a gap BETWEEN two late layout commits
  // (the exact "late correction" race this helper exists to absorb).
  let last = v.lastFrame();
  let quiet = 0;
  for (let i = 0; i < polls; i++) {
    await settle(gapMs);
    const next = v.lastFrame();
    quiet = next === last ? quiet + 1 : 0;
    last = next;
    if (quiet >= 3) return next;
  }
  return last;
}

/**
 * Wait until BOTH renders are simultaneously quiescent, polling them
 * alternately so they get equal budgets. Waiting sequentially would let the
 * first view consume part of its budget before the second even starts
 * (asymmetric convergence for frames that settle at different speeds).
 */
async function waitForStableFrames(
  a: RealTtyView,
  b: RealTtyView,
  polls = 24,
  gapMs = 25,
): Promise<[string, string]> {
  let frameA = a.lastFrame();
  let frameB = b.lastFrame();
  let quietA = 0;
  let quietB = 0;
  for (let i = 0; i < polls && (quietA < 3 || quietB < 3); i++) {
    await settle(gapMs);
    const nextA = a.lastFrame();
    const nextB = b.lastFrame();
    quietA = nextA === frameA ? quietA + 1 : 0;
    quietB = nextB === frameB ? quietB + 1 : 0;
    frameA = nextA;
    frameB = nextB;
  }
  return [frameA, frameB];
}

/** Drop the 2-column scrollbar band so frames compare on content only — the
 *  thumb legitimately moves when content grows below an anchored viewport. */
const contentOnly = (frame: string): string =>
  frame
    .split('\n')
    .map((line) => line.slice(0, -2))
    .join('\n');

/** Number of the topmost visible `Mnn` marker in a frame, or -1 if none. */
function topMarker(frame: string): number {
  for (const line of frame.split('\n')) {
    const m = line.match(/M(\d\d)/);
    if (m) return Number(m[1]);
  }
  return -1;
}

function makeEntries(count = 30): HistoryEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    const tall = i % 3 === 0;
    const text = tall
      ? `M${n} heading\n\n\`\`\`\ncode a\ncode b\ncode c\ncode d\n\`\`\`\ntrailer for M${n}`
      : `M${n} short line`;
    return { id: i + 1, kind: 'assistant', text } as HistoryEntry;
  });
}

function view(entries: HistoryEntry[], controllerRef: { current: HistoryScrollController | null }) {
  return (
    <ScrollableHistory
      entries={entries}
      toolStream={null}
      viewportRows={VP}
      controllerRef={controllerRef}
    />
  );
}

// The historic "lurch": wheel-scrolling through mixed-height markdown made the
// viewport bounce or jump to unrelated content because estimate→measured
// corrections moved the viewport onto unrelated entries between commits. One
// stable render-group anchor now drives the viewport while the scrollbar is
// derived from corrected prefix sums, so a wheel step may only ever move the
// top marker monotonically. These tests drive REAL Ink layout (fake TTY, real
// measureElement) and inspect the rendered content rather than state alone.
describe('scroll stability under real layout (lurch proof)', () => {
  it('wheel-up steps walk monotonically toward older content, no bounce', async () => {
    const controllerRef = { current: null as HistoryScrollController | null };
    const entries = makeEntries();
    const v = renderRealTty(view(entries, controllerRef), { columns: 60, rows: VP + 2 });
    await settle();
    expect(controllerRef.current).not.toBeNull();

    // Pinned: newest marker visible.
    expect(v.lastFrame()).toContain('M30');

    let prevTop = Number.POSITIVE_INFINITY;
    for (let step = 0; step < 20; step++) {
      controllerRef.current?.scrollBy(3);
      await settle();
      const top = topMarker(v.lastFrame());
      expect(top).toBeGreaterThan(0);
      // Monotonic: scrolling up never shows a NEWER top marker than before.
      expect(top).toBeLessThanOrEqual(prevTop);
      prevTop = top;
    }
    v.unmount();
  });

  it('accumulates batched wheel steps before React renders', async () => {
    const batchRef = { current: null as HistoryScrollController | null };
    const directRef = { current: null as HistoryScrollController | null };
    const entries = makeEntries();
    const batched = renderRealTty(view(entries, batchRef), { columns: 60, rows: VP + 2 });
    const direct = renderRealTty(view(entries, directRef), { columns: 60, rows: VP + 2 });
    await settle();

    // Raw stdin can deliver several SGR wheel reports in one data chunk. These
    // calls intentionally happen without a render/settle between them.
    for (let row = 0; row < 9; row++) batchRef.current?.scrollBy(1);
    directRef.current?.scrollBy(9);
    // Simultaneous quiescence on both renders with equal poll budgets (a
    // fixed settle() reads one in-flight Yoga correction frame on slow CI
    // and breaks equality by exactly one row).
    const [batchedFrame, directFrame] = await waitForStableFrames(batched, direct);

    expect(contentOnly(batchedFrame)).toBe(contentOnly(directFrame));
    batched.unmount();
    direct.unmount();
  });

  it('uses the same row delta for PageDown and an equivalent wheel distance', async () => {
    const pageRef = { current: null as HistoryScrollController | null };
    const wheelRef = { current: null as HistoryScrollController | null };
    const entries = makeEntries();
    const paged = renderRealTty(view(entries, pageRef), { columns: 60, rows: VP + 2 });
    const wheeled = renderRealTty(view(entries, wheelRef), { columns: 60, rows: VP + 2 });
    await settle();

    pageRef.current?.scrollToTop();
    wheelRef.current?.scrollToTop();
    await settle();
    pageRef.current?.scrollPage('down');
    wheelRef.current?.scrollBy(-(VP - 1));
    // Simultaneous quiescence on both renders (same single-row-offset race
    // as the batch test); equal poll budgets for both views.
    const [pagedFrame, wheeledFrame] = await waitForStableFrames(paged, wheeled);

    expect(contentOnly(pagedFrame)).toBe(contentOnly(wheeledFrame));
    paged.unmount();
    wheeled.unmount();
  });

  it('returns to the exact same frame after one row up and down from a track position', async () => {
    const controllerRef = { current: null as HistoryScrollController | null };
    const entries = makeEntries();
    const v = renderRealTty(view(entries, controllerRef), { columns: 60, rows: VP + 2 });
    await settle();

    controllerRef.current?.scrollToTrackCell(Math.floor(VP / 2));
    await settle();
    // Quiescence before capturing the baseline (and again after the two wheel
    // steps): a mid-correction baseline is what makes the round-trip compare
    // off by one row on slow runners.
    const selected = contentOnly(await waitForStableFrame(v));
    controllerRef.current?.scrollBy(1);
    await settle();
    controllerRef.current?.scrollBy(-1);
    const settledFrame = await waitForStableFrame(v);

    expect(contentOnly(settledFrame)).toBe(selected);
    v.unmount();
  });

  it('keeps the selected entry stable while wildly wrong cached heights are corrected', async () => {
    const controllerRef = { current: null as HistoryScrollController | null };
    const entries = Array.from(
      { length: 60 },
      (_, index) =>
        ({
          id: index + 1,
          kind: 'assistant',
          text: `M${String(index + 1).padStart(2, '0')} short line`,
        }) as HistoryEntry,
    );
    const layoutStore = new LayoutStore({ sessionDataDir: undefined, ephemeral: true });
    layoutStore.setTermWidth(58);
    for (const entry of entries) {
      const text = 'text' in entry ? entry.text : '';
      layoutStore.set(entry.id, {
        ...computeLayout(entry.id, entry.kind, text, 58),
        rows: 40,
        kind: 'measured',
      });
    }
    const v = renderRealTty(
      <ScrollableHistory
        entries={entries}
        toolStream={null}
        viewportRows={20}
        controllerRef={controllerRef}
        layoutStore={layoutStore}
      />,
      { columns: 60, rows: 22 },
    );
    await settle(200);

    const frameStart = v.stdout.frames.length;
    controllerRef.current?.scrollToTrackCell(10);
    await settle(500);
    const markers = v.stdout.frames
      .slice(frameStart)
      .map(topMarker)
      .filter((marker) => marker > 0);
    expect(markers.length).toBeGreaterThan(0);
    const selectedMarker = markers[0] ?? -1;
    const finalMarker = markers.at(-1) ?? -1;
    // Initial pinned-window measurements already refine part of the persisted
    // extent, so the exact selected id is deliberately not hard-coded. Once
    // the track selection renders, correcting its wildly wrong local heights
    // may expose one adjacent marker but must not walk across unrelated cards.
    expect(Math.abs(finalMarker - selectedMarker)).toBeLessThanOrEqual(1);
    expect(Math.max(...markers) - Math.min(...markers)).toBeLessThanOrEqual(1);
    v.unmount();
  });

  it('keeps the same logical content anchored through a width reflow', async () => {
    const controllerRef = { current: null as HistoryScrollController | null };
    const entries = makeEntries(30);
    const v = renderRealTty(view(entries, controllerRef), { columns: 72, rows: VP + 2 });
    await settle(250);

    controllerRef.current?.scrollToTrackCell(Math.floor(VP / 2));
    await settle(150);
    const selectedMarker = topMarker(v.lastFrame());
    expect(selectedMarker).toBeGreaterThan(0);

    const frameStart = v.stdout.frames.length;
    v.resize(44, VP + 2);
    await settle(350);
    const markers = v.stdout.frames
      .slice(frameStart)
      .map(topMarker)
      .filter((marker) => marker > 0);
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect(Math.abs(marker - selectedMarker)).toBeLessThanOrEqual(1);
    }
    v.unmount();
  });

  it('the visible frame does not move when entries are appended below while scrolled', async () => {
    const controllerRef = { current: null as HistoryScrollController | null };
    const entries = makeEntries();
    const v = renderRealTty(view(entries, controllerRef), { columns: 60, rows: VP + 2 });
    await settle();

    controllerRef.current?.scrollPage('up');
    controllerRef.current?.scrollPage('up');
    await settle();
    const before = v.lastFrame();
    expect(before).not.toContain('M30');

    // Stream three new entries in — the anchored viewport must not move.
    // (Only the scrollbar thumb may shift: content grew below the anchor.)
    const more = makeEntries(33);
    v.rerender(view(more, controllerRef));
    await settle();
    const after = v.lastFrame();
    expect(contentOnly(after)).toBe(contentOnly(before));
    v.unmount();
  });

  it('scrollToTop shows the oldest entry at the top edge; scrollToBottom re-pins', async () => {
    const controllerRef = { current: null as HistoryScrollController | null };
    const entries = makeEntries();
    const v = renderRealTty(view(entries, controllerRef), { columns: 60, rows: VP + 2 });
    await settle();

    controllerRef.current?.scrollToTop();
    await settle();
    const atTop = v.lastFrame();
    expect(topMarker(atTop)).toBe(1);
    expect(controllerRef.current?.isScrolled()).toBe(true);

    controllerRef.current?.scrollToBottom();
    await settle();
    expect(v.lastFrame()).toContain('M30');
    expect(controllerRef.current?.isScrolled()).toBe(false);
    v.unmount();
  });

  it('page-down from the top returns to the bottom and every frame is full', async () => {
    const controllerRef = { current: null as HistoryScrollController | null };
    const entries = makeEntries();
    const v = renderRealTty(view(entries, controllerRef), { columns: 60, rows: VP + 2 });
    await settle();

    controllerRef.current?.scrollToTop();
    await settle();
    for (let i = 0; i < 30 && controllerRef.current?.isScrolled(); i++) {
      controllerRef.current?.scrollPage('down');
      await settle();
      // The viewport band must never be blank while content exists: at least
      // one marker line is always visible in the history area.
      expect(topMarker(v.lastFrame())).toBeGreaterThan(0);
    }
    expect(controllerRef.current?.isScrolled()).toBe(false);
    expect(v.lastFrame()).toContain('M30');
    v.unmount();
  });
});
