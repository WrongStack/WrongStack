import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../src/components/history.js';
import {
  type HistoryScrollController,
  ScrollableHistory,
} from '../src/components/scrollable-history.js';
import { cleanFrame, renderRealTty, settle } from './helpers/real-tty.js';

function collapsingEntries(count: number): HistoryEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    kind: 'assistant',
    text: `M${index + 1} first${'\n'.repeat(100)}M${index + 1} last`,
  })) as HistoryEntry[];
}

function maxHistoryBlankRun(frame: string, viewportRows: number): number {
  let run = 0;
  let max = 0;
  for (const line of cleanFrame(frame).split('\n').slice(0, viewportRows)) {
    // Remove the managed scrollbar's gap + track before deciding whether the
    // chat row itself is empty.
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

function expectNoBlankBand(frames: string[], viewportRows: number): void {
  expect(frames.length).toBeGreaterThan(0);
  frames.forEach((frame, index) => {
    expect(
      maxHistoryBlankRun(frame, viewportRows),
      `frame ${index + 1} contains an empty chat-history band`,
    ).toBeLessThanOrEqual(2);
  });
}

describe('virtual scroll frame integrity', () => {
  const VP = 80;

  it('keeps every emitted wheel/page/track frame filled', async () => {
    const entries = collapsingEntries(100);
    const controllerRef = createRef<HistoryScrollController>();
    const tty = renderRealTty(view(entries, VP, controllerRef), {
      columns: 100,
      rows: VP + 4,
    });
    await settle(300);

    const start = tty.stdout.frames.length;
    controllerRef.current?.scrollToTop();
    await settle(20);
    controllerRef.current?.scrollPage('down');
    await settle(20);
    controllerRef.current?.scrollToTrackCell(Math.floor(VP / 2));
    await settle(20);
    for (let step = 0; step < 12; step++) {
      controllerRef.current?.scrollBy(step % 2 === 0 ? 1 : -1);
      await settle(5);
    }
    await settle(100);

    expectNoBlankBand(tty.stdout.frames.slice(start), VP);
    tty.unmount();
  });

  it('keeps every emitted resize frame filled while scrolled', async () => {
    const entries = collapsingEntries(100);
    const controllerRef = createRef<HistoryScrollController>();
    const tty = renderRealTty(view(entries, VP, controllerRef), {
      columns: 100,
      rows: VP + 4,
    });
    await settle(300);
    controllerRef.current?.scrollToTrackCell(Math.floor(VP / 2));
    await settle(100);

    const start = tty.stdout.frames.length;
    tty.resize(70, VP + 4);
    await settle(300);

    expectNoBlankBand(tty.stdout.frames.slice(start), VP);
    tty.unmount();
  });
});
