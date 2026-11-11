import { EventBus } from '@wrongstack/contracts/kernel';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import type { Action } from '../src/app-action-type.js';
import {
  createLiveStreamDispatch,
  EMPTY_LIVE_STREAM,
  isLiveStreamOnlyAction,
  LiveStreamStore,
  liveStreamStoreOf,
  reduceLiveStream,
} from '../src/live-stream-store.js';
import { resetTuiMemoryCounters, snapshotTuiMemoryCounters } from '../src/tui-memory-counters.js';
import { createAppJourney, createJourneyAgent } from './helpers/app-journey-harness.js';
import { cleanFrame, type RealTtyView, renderRealTty } from './helpers/real-tty.js';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the TUI frame');
    await wait(10);
  }
}

describe('reduceLiveStream', () => {
  it('returns the same object for actions the live slice does not own', () => {
    const live = { ...EMPTY_LIVE_STREAM, streamingText: 'tail' };
    expect(reduceLiveStream(live, { type: 'interrupt' })).toBe(live);
    expect(reduceLiveStream(live, { type: 'toolStreamClear' })).toBe(live);
  });

  it('starts the activity line on the first non-idle status and ends it on idle', () => {
    let live = reduceLiveStream(EMPTY_LIVE_STREAM, { type: 'status', status: 'running' });
    const started = live.streamActivity;
    expect(started).not.toBeNull();
    live = reduceLiveStream(live, { type: 'toolStarted', id: 't1', name: 'bash' });
    expect(live.toolStream).toMatchObject({ toolUseId: 't1', name: 'bash', text: '' });
    // A later status of the same run keeps the run's counters.
    live = reduceLiveStream(live, { type: 'status', status: 'streaming' });
    expect(live.streamActivity).toBe(started);
    live = reduceLiveStream(live, { type: 'status', status: 'idle' });
    expect(live.status).toBe('idle');
    expect(live.toolStream).toBeNull();
    expect(live.streamActivity?.endedAt).toBeTypeOf('number');
    // A repeated idle changes nothing, so no reader re-renders.
    expect(reduceLiveStream(live, { type: 'status', status: 'idle' })).toBe(live);
  });

  it('appends to the streaming tool and switches when another tool writes', () => {
    let live = reduceLiveStream(EMPTY_LIVE_STREAM, {
      type: 'toolStreamAppend',
      toolUseId: 't1',
      name: 'bash',
      text: 'one\n',
      startedAt: 5,
    });
    live = reduceLiveStream(live, {
      type: 'toolStreamAppend',
      toolUseId: 't1',
      name: 'bash',
      text: 'two\n',
      startedAt: 9,
    });
    expect(live.toolStream).toEqual({
      toolUseId: 't1',
      name: 'bash',
      text: 'one\ntwo\n',
      startedAt: 5,
    });
    live = reduceLiveStream(live, {
      type: 'toolStreamAppend',
      toolUseId: 't2',
      name: 'grep',
      text: 'hit',
      startedAt: 11,
    });
    expect(live.toolStream).toEqual({ toolUseId: 't2', name: 'grep', text: 'hit', startedAt: 11 });
    // A stale finish for the earlier tool must not blank the visible one.
    expect(reduceLiveStream(live, { type: 'toolStreamClear', toolUseId: 't1' })).toBe(live);
    expect(reduceLiveStream(live, { type: 'toolStreamClear', name: 'bash' })).toBe(live);
    expect(reduceLiveStream(live, { type: 'toolStreamClear', name: 'grep' }).toolStream).toBeNull();
  });

  it('folds a batch through the same transitions', () => {
    const live = reduceLiveStream(EMPTY_LIVE_STREAM, {
      type: 'fleetBatch',
      actions: [
        { type: 'streamDelta', delta: 'a' },
        { type: 'streamDelta', delta: 'b' },
      ],
    });
    expect(live.streamingText).toBe('ab');
  });
});

describe('createLiveStreamDispatch', () => {
  it('keeps per-flush actions away from the root reducer and shares the rest', () => {
    const root = vi.fn<(action: Action) => void>();
    const store = new LiveStreamStore();
    const notified = vi.fn();
    store.subscribe(notified);
    const dispatch = createLiveStreamDispatch(root, store);

    dispatch({ type: 'streamDelta', delta: 'hello' });
    dispatch({
      type: 'toolStreamAppend',
      toolUseId: 't1',
      name: 'bash',
      text: 'out',
      startedAt: 1,
    });
    dispatch({ type: 'streamActivityFrame', frame: { type: 'tool.started' } });
    dispatch({ type: 'toolStreamClear', toolUseId: 't1' });
    dispatch({ type: 'streamReset' });
    expect(root).not.toHaveBeenCalled();
    expect(notified).toHaveBeenCalledTimes(5);

    // Run status and tool starts change both sides.
    dispatch({ type: 'status', status: 'running' });
    dispatch({ type: 'toolStarted', id: 't2', name: 'read' });
    expect(root.mock.calls.map(([action]) => action.type)).toEqual(['status', 'toolStarted']);
    expect(store.get().toolStream?.toolUseId).toBe('t2');

    // Root-only actions reach the root and leave the store's readers alone.
    notified.mockClear();
    dispatch({ type: 'interrupt' });
    expect(root).toHaveBeenLastCalledWith({ type: 'interrupt' });
    expect(notified).not.toHaveBeenCalled();
  });

  it('is reachable from the dispatch it was paired with', () => {
    const store = new LiveStreamStore();
    const dispatch = createLiveStreamDispatch(() => {}, store);
    expect(liveStreamStoreOf(dispatch)).toBe(store);
    // An unpaired dispatch (a test double, a detached caller) reads empty.
    expect(liveStreamStoreOf(() => {}).get()).toBe(EMPTY_LIVE_STREAM);
  });

  it('names exactly the actions the root reducer ignores', () => {
    const liveOnly: Action[] = [
      { type: 'streamDelta', delta: 'x' },
      { type: 'streamReset' },
      { type: 'streamActivityFrame', frame: { type: 'iteration.started' } },
      { type: 'toolStreamAppend', toolUseId: 't', name: 'bash', text: 'x', startedAt: 1 },
      { type: 'toolStreamClear' },
    ];
    for (const action of liveOnly) expect(isLiveStreamOnlyAction(action)).toBe(true);
    expect(isLiveStreamOnlyAction({ type: 'status', status: 'idle' })).toBe(false);
    expect(isLiveStreamOnlyAction({ type: 'toolStarted', id: 't', name: 'bash' })).toBe(false);
    expect(isLiveStreamOnlyAction({ type: 'clearHistory' })).toBe(false);
  });
});

describe('App streaming through the live store', () => {
  let view: RealTtyView | undefined;

  afterEach(() => {
    view?.unmount();
    view = undefined;
  });

  function mountApp(): { events: EventBus; view: RealTtyView } {
    const agent = createJourneyAgent();
    const journey = createAppJourney(agent);
    const events = new EventBus();
    const mounted = renderRealTty(
      React.createElement(App, { ...journey.props, events, banner: false, enhanceEnabled: false }),
      { columns: 100, rows: 36 },
    );
    view = mounted;
    return { events, view: mounted };
  }

  it('paints streamed text without re-rendering the App on each flush', async () => {
    const { events, view } = mountApp();
    await wait(300);
    resetTuiMemoryCounters();

    // Spread the deltas over several flush windows.
    for (let i = 0; i < 24; i++) {
      events.emit('provider.text_delta', { text: `line${i}\n` } as never);
      await wait(25);
    }
    await waitFor(() => view.lastFrame().includes('line23'));

    const counters = snapshotTuiMemoryCounters();
    expect(counters.streamFlushes).toBeGreaterThanOrEqual(4);
    // Before the live store every flush dispatched into the root reducer, so
    // App renders tracked flushes one for one (plus timers).
    expect(counters.appRenders).toBeLessThan(counters.streamFlushes / 2);
  });

  it('replaces the live tail with the committed entry in a single frame', async () => {
    const { events, view } = mountApp();
    await wait(300);

    events.emit('provider.text_delta', { text: 'HANDOFFMARKER streamed reply' } as never);
    await waitFor(() => view.lastFrame().includes('HANDOFFMARKER'));
    const firstVisible = view.stdout.frames.findIndex((frame) => frame.includes('HANDOFFMARKER'));

    events.emit('provider.response', {
      content: [{ type: 'text', text: 'HANDOFFMARKER streamed reply' }],
      stopReason: 'end_turn',
    } as never);
    await wait(250);

    // The bridge clears the tail and commits the entry in one tick. Debug-mode
    // Ink writes a frame per commit, so a frame without the text here would
    // mean the two landed in separate renders: a visible blink in a terminal.
    const after = view.stdout.frames.slice(firstVisible).map(cleanFrame);
    expect(after.length).toBeGreaterThan(1);
    expect(after.filter((frame) => !frame.includes('HANDOFFMARKER'))).toEqual([]);
  });
});
