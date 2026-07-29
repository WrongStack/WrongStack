import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../src/components/history.js';
import {
  type HistoryScrollController,
  ScrollableHistory,
} from '../src/components/scrollable-history.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

/** Drop the 2-column scrollbar band so assertions read content only. */
const contentLines = (frame: string): string[] =>
  frame.split('\n').map((line) => line.slice(0, -2).trimEnd());

/** Longest run of consecutive blank content rows in a frame. Entry cards
 *  legitimately separate with up to ~2 blank rows; a longer run is a hole the
 *  viewport should never show while enough content exists. */
function longestBlankRun(frame: string): number {
  let run = 0;
  let longest = 0;
  for (const line of contentLines(frame)) {
    run = line === '' ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

/** Interleaved transcript: every visible card Mnn is followed by a LONG
 *  thinking entry (50 source lines). With reasoning display off each thinking
 *  entry renders ZERO rows — if its seeded estimate survives in the height
 *  cache, the transcript gains ~50 phantom rows per turn: the wheel scrolls
 *  through nothing, the mount plan under-mounts (blank viewport), and the
 *  scrollbar maps to content that does not exist on screen. */
function makeEntries(cards: number): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  let id = 1;
  for (let i = 1; i <= cards; i++) {
    const n = String(i).padStart(2, '0');
    entries.push({ id: id++, kind: 'assistant', text: `M${n} line` } as HistoryEntry);
    entries.push({
      id: id++,
      kind: 'thinking',
      text: Array.from({ length: 50 }, (_, r) => `reasoning row ${r + 1} of turn ${n}`).join('\n'),
    } as HistoryEntry);
  }
  return entries;
}

function view(
  entries: HistoryEntry[],
  controllerRef: { current: HistoryScrollController | null },
  viewportRows: number,
  showModelReasoning: boolean,
) {
  return (
    <ScrollableHistory
      entries={entries}
      toolStream={null}
      viewportRows={viewportRows}
      controllerRef={controllerRef}
      showModelReasoning={showModelReasoning}
    />
  );
}

// Hidden model reasoning: `kind:'thinking'` entries render as an empty
// fragment when the user turns the reasoning display off. Their cached rows
// must be ZERO — a stale estimate (the whole reasoning text) becomes phantom
// scroll space that the measurement pass used to be unable to correct because
// zero-height measurements were skipped and the cache floored heights at 1.
describe('virtual scroll with model reasoning hidden', () => {
  it('wheel-up reaches the oldest card in visible-content ticks, never showing holes', async () => {
    const VP = 20;
    const controllerRef = { current: null as HistoryScrollController | null };
    const v = renderRealTty(view(makeEntries(10), controllerRef, VP, false), {
      columns: 60,
      rows: VP + 2,
    });
    await settle();
    expect(v.lastFrame()).toContain('M10');
    expect(v.lastFrame()).not.toContain('reasoning row');

    // 10 cards render ~4 rows each with reasoning hidden. Wheel up one row at
    // a time: with zero-height thinking entries the top card must appear
    // within the real content extent (+ generous slack). With phantom rows it
    // would take ~500 extra ticks and the viewport would blank out instead.
    let sawTop = false;
    for (let tick = 0; tick < 80; tick++) {
      controllerRef.current?.scrollBy(1);
      await settle();
      const frame = v.lastFrame() ?? '';
      expect(
        longestBlankRun(frame),
        `hole while wheeling up (tick ${tick + 1}):\n${frame}`,
      ).toBeLessThanOrEqual(3);
      expect(frame).not.toContain('reasoning row');
      if (frame.includes('M01')) {
        sawTop = true;
        break;
      }
    }
    expect(sawTop, 'M01 never became visible: phantom reasoning rows in scroll space').toBe(true);
    v.unmount();
  });

  it('scrollToTop lands on the first card with a full viewport', async () => {
    const VP = 20;
    const controllerRef = { current: null as HistoryScrollController | null };
    const v = renderRealTty(view(makeEntries(10), controllerRef, VP, false), {
      columns: 60,
      rows: VP + 2,
    });
    await settle();

    controllerRef.current?.scrollToTop();
    await settle();
    const frame = v.lastFrame() ?? '';
    expect(frame).toContain('M01');
    expect(
      longestBlankRun(frame),
      `hole after scrollToTop with hidden reasoning:\n${frame}`,
    ).toBeLessThanOrEqual(3);
    v.unmount();
  });

  it('turning reasoning off while scrolled re-seeds heights without holes', async () => {
    const VP = 20;
    const controllerRef = { current: null as HistoryScrollController | null };
    // Start with reasoning visible so thinking entries carry real (large)
    // measured heights, and scroll into the middle of the transcript.
    const v = renderRealTty(view(makeEntries(10), controllerRef, VP, true), {
      columns: 60,
      rows: VP + 2,
    });
    await settle();
    controllerRef.current?.scrollToTop();
    await settle();
    controllerRef.current?.scrollBy(-40);
    await settle();
    expect(controllerRef.current?.isScrolled()).toBe(true);

    // Toggle reasoning off: every thinking entry collapses to zero rows. The
    // cache must re-seed (the flag participates in the cache key) and the
    // viewport must stay full of the remaining visible cards.
    v.rerender(view(makeEntries(10), controllerRef, VP, false));
    await settle();
    const frame = v.lastFrame() ?? '';
    expect(frame).not.toContain('reasoning row');
    expect(
      longestBlankRun(frame),
      `hole after hiding reasoning while scrolled:\n${frame}`,
    ).toBeLessThanOrEqual(3);
    v.unmount();
  });

  it('turning reasoning back on while scrolled restores blocks without holes', async () => {
    const VP = 20;
    const controllerRef = { current: null as HistoryScrollController | null };
    // Start hidden (thinking entries at zero rows), scroll away from the tail,
    // then re-enable reasoning: cached zero heights are stale for the now-
    // visible blocks and must heal via re-seed + remount measurement.
    const v = renderRealTty(view(makeEntries(10), controllerRef, VP, false), {
      columns: 60,
      rows: VP + 2,
    });
    await settle();
    controllerRef.current?.scrollToTop();
    await settle();
    controllerRef.current?.scrollBy(-10);
    await settle();

    v.rerender(view(makeEntries(10), controllerRef, VP, true));
    await settle();
    const frame = v.lastFrame() ?? '';
    expect(
      longestBlankRun(frame),
      `hole after re-enabling reasoning while scrolled:\n${frame}`,
    ).toBeLessThanOrEqual(3);

    // And the reasoning text itself must be reachable again by scrolling.
    controllerRef.current?.scrollToBottom();
    await settle();
    controllerRef.current?.scrollBy(6);
    await settle();
    expect(v.lastFrame()).toContain('reasoning row');
    v.unmount();
  });

  it('pinned viewport stays full when the transcript is mostly hidden reasoning', async () => {
    const VP = 16;
    const controllerRef = { current: null as HistoryScrollController | null };
    const v = renderRealTty(view(makeEntries(12), controllerRef, VP, false), {
      columns: 60,
      rows: VP + 2,
    });
    await settle();
    const frame = v.lastFrame() ?? '';
    expect(frame).toContain('M12');
    expect(
      longestBlankRun(frame),
      `pinned hole with hidden reasoning:\n${frame}`,
    ).toBeLessThanOrEqual(3);
    v.unmount();
  });
});
