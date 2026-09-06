import { render } from 'ink-testing-library';
import type React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HistoryScrollController } from '../src/components/scrollable-history.js';
import {
  HISTORY_AUTO_SCROLL_DELAY_MS,
  useHistoryAutoScroll,
} from '../src/hooks/use-history-auto-scroll.js';
import { Text } from '../src/ink.js';

afterEach(() => {
  vi.useRealTimers();
});

function AutoScrollHarness({
  historyScrolled,
  historyScrollRef,
  activityRef,
}: {
  historyScrolled: boolean;
  historyScrollRef: { current: HistoryScrollController | null };
  activityRef?: { current: (() => void) | null };
}): React.ReactElement {
  const onHistoryScrollActivity = useHistoryAutoScroll({ historyScrolled, historyScrollRef });
  if (activityRef) activityRef.current = onHistoryScrollActivity;
  return <Text>history</Text>;
}

describe('useHistoryAutoScroll', () => {
  it('returns a scrolled history viewport to the live tail after 30 seconds', () => {
    vi.useFakeTimers();
    const scrollToBottom = vi.fn();
    const historyScrollRef = {
      current: { scrollToBottom } as unknown as HistoryScrollController,
    };
    const view = render(
      <AutoScrollHarness historyScrolled={true} historyScrollRef={historyScrollRef} />,
    );

    act(() => vi.advanceTimersByTime(HISTORY_AUTO_SCROLL_DELAY_MS - 1));
    expect(scrollToBottom).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('cancels the pending return when the user re-pins to the live tail', () => {
    vi.useFakeTimers();
    const scrollToBottom = vi.fn();
    const historyScrollRef = {
      current: { scrollToBottom } as unknown as HistoryScrollController,
    };
    const view = render(
      <AutoScrollHarness historyScrolled={true} historyScrollRef={historyScrollRef} />,
    );

    view.rerender(
      <AutoScrollHarness historyScrolled={false} historyScrollRef={historyScrollRef} />,
    );
    act(() => vi.advanceTimersByTime(HISTORY_AUTO_SCROLL_DELAY_MS));

    expect(scrollToBottom).not.toHaveBeenCalled();
    view.unmount();
  });

  it('restarts the delay while the user keeps navigating older history', () => {
    vi.useFakeTimers();
    const scrollToBottom = vi.fn();
    const historyScrollRef = {
      current: { scrollToBottom } as unknown as HistoryScrollController,
    };
    const activityRef = { current: null as (() => void) | null };
    const view = render(
      <AutoScrollHarness
        historyScrolled={true}
        historyScrollRef={historyScrollRef}
        activityRef={activityRef}
      />,
    );

    act(() => vi.advanceTimersByTime(HISTORY_AUTO_SCROLL_DELAY_MS - 1));
    act(() => activityRef.current?.());
    act(() => vi.advanceTimersByTime(1));
    expect(scrollToBottom).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(HISTORY_AUTO_SCROLL_DELAY_MS - 1));
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
