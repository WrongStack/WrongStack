// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTreeChanges } from '../src/FileTreeView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({
  changed,
  refresh,
  onError,
}: {
  changed: unknown;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  useTreeChanges(changed, refresh, onError);
  return null;
}

describe('the file tree follows changes on disk', () => {
  afterEach(() => vi.useRealTimers());

  it('reloads after a later change frame, not for the one present when it opened', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    const onError = vi.fn();
    const root = createRoot(document.createElement('div'));
    const opened = {};
    act(() => root.render(createElement(Probe, { changed: opened, refresh, onError })));
    act(() => vi.advanceTimersByTime(1000));
    expect(refresh).not.toHaveBeenCalled();
    act(() => root.render(createElement(Probe, { changed: {}, refresh, onError })));
    act(() => root.render(createElement(Probe, { changed: {}, refresh, onError })));
    await act(async () => vi.advanceTimersByTime(300));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('reports a failed reload', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => {
      throw new Error('engine is not connected');
    });
    const onError = vi.fn();
    const root = createRoot(document.createElement('div'));
    act(() => root.render(createElement(Probe, { changed: undefined, refresh, onError })));
    act(() => root.render(createElement(Probe, { changed: {}, refresh, onError })));
    await act(async () => vi.advanceTimersByTime(300));
    expect(onError).toHaveBeenCalledWith('engine is not connected');
  });
});
