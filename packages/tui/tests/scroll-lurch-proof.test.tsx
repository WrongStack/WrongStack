import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../src/components/history.js';
import {
  type HistoryScrollController,
  ScrollableHistory,
} from '../src/components/scrollable-history.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

const VP = 12;

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

function view(
  entries: HistoryEntry[],
  controllerRef: { current: HistoryScrollController | null },
) {
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
// corrections moved the offset-based window between commits. The anchor model
// renders from (entry, clip) directly, so a wheel step may only ever move the
// top marker monotonically — these tests drive REAL Ink layout (fake TTY, real
// measureElement) and would have caught the original bug.
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
    await settle();

    expect(contentOnly(batched.lastFrame())).toBe(contentOnly(direct.lastFrame()));
    batched.unmount();
    direct.unmount();
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
