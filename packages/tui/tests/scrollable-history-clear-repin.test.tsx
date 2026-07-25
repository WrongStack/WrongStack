import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../src/components/history.js';
import {
  type HistoryScrollController,
  ScrollableHistory,
} from '../src/components/scrollable-history.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

/**
 * Mount regression for `/clear` re-pinning the managed virtual-scroll viewport.
 *
 * `ScrollableHistory` keeps its scroll position, height-cache buffer, and
 * measured-group set in component-local refs/state that the app reducer cannot
 * reach. `clearHistory` only reports `historyScrolled:false` and bumps
 * `historyGen`; app-view.tsx turns that bump into a real reset by keying the
 * component `key={`history-gen-${state.historyGen}`}`, so the generation change
 * remounts the component and its internal state returns to the initial
 * pinned/follow position.
 *
 * The reducer half is covered in reducer.test.ts. This test guards the wiring:
 * without the key, a user who had scrolled up would stay in "scrolled-away"
 * mode after a clear and new output would no longer auto-follow. It reproduces
 * that exact sequence — scroll up, then clear via a historyGen bump — through a
 * wrapper that mirrors app-view.tsx's keying, and asserts the viewport is back
 * in follow mode showing the newest (post-clear) content.
 *
 * Uses the real-TTY harness so yoga runs a true layout and `measureElement`
 * returns real heights — the estimate-only ink-testing-library stream would
 * skip the measurement path this scroll behaviour depends on.
 */

const banner: HistoryEntry = {
  id: 0,
  kind: 'banner',
  version: '9.9.9',
  provider: 'openai',
  model: 'gpt-test',
  cwd: '/workspace/wrongstack',
};

const fullHistory: HistoryEntry[] = [
  banner,
  ...Array.from({ length: 50 }, (_, index) => ({
    id: index + 1,
    kind: 'user' as const,
    text: `history-entry-${String(index + 1).padStart(2, '0')}`,
  })),
];

// A fresh session after the clear: the surviving banner plus enough NEW output
// to overflow the viewport. This makes follow-vs-scrolled observable — a pinned
// viewport shows the newest fresh entry, a stale-scrolled one top-anchors on the
// oldest. A negative control without the historyGen key fails these assertions,
// confirming the key is load-bearing.
const freshSession: HistoryEntry[] = [
  banner,
  ...Array.from({ length: 20 }, (_, index) => ({
    id: 100 + index,
    kind: 'user' as const,
    text: `fresh-entry-${String(index + 1).padStart(2, '0')}`,
  })),
];

/**
 * Mirror of app-view.tsx's mount: the managed viewport keyed by historyGen so a
 * generation bump (what `clearHistory` produces) forces a remount.
 */
function KeyedHistory(props: {
  historyGen: number;
  entries: HistoryEntry[];
  controllerRef: { current: HistoryScrollController | null };
}): ReactElement {
  return (
    <ScrollableHistory
      key={`history-gen-${props.historyGen}`}
      entries={props.entries}
      toolStream={null}
      viewportRows={8}
      controllerRef={props.controllerRef}
    />
  );
}

describe('<ScrollableHistory /> /clear re-pin', () => {
  it('remounts into pinned/follow mode when historyGen bumps (mirrors /clear)', async () => {
    const controllerRef = { current: null as HistoryScrollController | null };
    const view = renderRealTty(
      <KeyedHistory historyGen={0} entries={fullHistory} controllerRef={controllerRef} />,
      { columns: 60, rows: 10 },
    );
    await settle();

    // Baseline: pinned to the newest output.
    const pinned = view.lastFrame();
    expect(pinned).toContain('history-entry-50');
    expect(pinned).not.toContain('history-entry-01');
    expect(controllerRef.current?.isScrolled()).toBe(false);

    // User scrolls up to the oldest retained entry.
    controllerRef.current?.scrollToTop();
    await settle();
    const scrolledUp = view.lastFrame();
    expect(scrolledUp).toContain('history-entry-01');
    expect(scrolledUp).not.toContain('history-entry-50');
    expect(controllerRef.current?.isScrolled()).toBe(true);

    // /clear: history is replaced by a fresh session AND historyGen bumps. The
    // key change remounts ScrollableHistory, discarding the scrolled position so
    // the new viewport starts pinned and auto-follows the newest output.
    view.rerender(
      <KeyedHistory historyGen={1} entries={freshSession} controllerRef={controllerRef} />,
    );
    await settle();

    const afterClear = view.lastFrame();
    // Pinned/follow mode: the newest fresh entry is visible…
    expect(afterClear).toContain('fresh-entry-20');
    // …the oldest fresh entry is scrolled off the bottom-anchored viewport…
    expect(afterClear).not.toContain('fresh-entry-01');
    // …none of the pre-clear content survives…
    expect(afterClear).not.toContain('history-entry-01');
    expect(afterClear).not.toContain('history-entry-50');
    // …and the remounted controller reports follow mode, not scrolled-away.
    expect(controllerRef.current?.isScrolled()).toBe(false);

    view.unmount();
  });
});
