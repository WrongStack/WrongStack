/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SurfaceHostProvider } from '../src/host.js';
import type { ChronicleEventView } from '../src/story/chronicle-types.js';
import { useStoryHistory } from '../src/story/use-story-history.js';

function makeEvent(sessionId: string, id: string): ChronicleEventView {
  return {
    eventId: id,
    eventType: 'tool.executed',
    outcome: 'success',
    occurredAt: '2026-11-18T12:00:00.000Z',
    scope: { sessionId },
    correlation: {},
    attributes: {},
  } as unknown as ChronicleEventView;
}

async function flushMicrotasks(turns = 14) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe('useStoryHistory sync-throw recovery, cross-session masking, and loadEarlier guard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('recovers from synchronous queryChronicle throws without leaking timers, masks stale state across session switches, and ignores loadEarlier without cursor', async () => {
    vi.useFakeTimers();
    let mode: 'normal' | 'sync-throw' = 'normal';
    const queries: Array<{ sessionId: string; cursor?: string }> = [];
    const renderSnapshots: Array<{
      total: number;
      error: string | null;
      cursor: string | undefined;
      eventsLen: number;
    }> = [];
    let latest!: ReturnType<typeof useStoryHistory>;

    const feed = {
      supportsChronicle: () => true,
      refreshMail: () => {},
      queryChronicle: (req: { sessionId?: string; cursor?: string }) => {
        if (mode === 'sync-throw') {
          throw new Error('Chronicle transport closed');
        }
        queries.push({
          sessionId: req.sessionId ?? '',
          ...(req.cursor ? { cursor: req.cursor } : {}),
        });
        if (req.cursor === 'c-page2') {
          return Promise.resolve({
            events: [makeEvent(req.sessionId ?? '', 'ev-2')],
            total: 2,
            nextCursor: undefined,
          });
        }
        return Promise.resolve({
          events: [makeEvent(req.sessionId ?? '', 'ev-1')],
          total: 2,
          nextCursor: 'c-page2',
        });
      },
    } as never;

    const host = { story: feed } as never;

    function Probe({ sessionId }: { sessionId: string | null }) {
      const h = useStoryHistory(sessionId, false);
      latest = h;
      renderSnapshots.push({
        total: h.total,
        error: h.error,
        cursor: h.cursor,
        eventsLen: h.events.length,
      });
      return null;
    }

    await act(async () => {
      root.render(
        <SurfaceHostProvider host={host}>
          <Probe sessionId="S1" />
        </SurfaceHostProvider>,
      );
      await flushMicrotasks();
    });
    expect(latest.events).toHaveLength(1);
    expect(latest.cursor).toBe('c-page2');

    await act(async () => {
      latest.loadEarlier();
      await flushMicrotasks();
    });
    expect(latest.events).toHaveLength(2);
    expect(latest.cursor).toBeUndefined();

    // Calling loadEarlier with undefined cursor is a no-op and preserves page 2
    await act(async () => {
      latest.loadEarlier();
      await flushMicrotasks();
    });
    expect(latest.events).toHaveLength(2);

    // Switching sessionId immediately masks S1's total/cursor on the switch render
    renderSnapshots.length = 0;
    await act(async () => {
      root.render(
        <SurfaceHostProvider host={host}>
          <Probe sessionId="S2" />
        </SurfaceHostProvider>,
      );
      await flushMicrotasks();
    });
    expect(renderSnapshots[0]).toEqual({
      total: 0,
      error: null,
      cursor: undefined,
      eventsLen: 0,
    });

    // Synchronous throw clears the 15s reply timeout, releases pending.current, and allows retry
    mode = 'sync-throw';
    await act(async () => {
      latest.refresh();
      await flushMicrotasks();
    });
    expect(latest.error).toBe('Chronicle transport closed');
    expect(latest.loading).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    mode = 'normal';
    const beforeCount = queries.length;
    await act(async () => {
      latest.refresh();
      await flushMicrotasks();
    });
    expect(queries.length).toBe(beforeCount + 1);
    expect(latest.error).toBeNull();
  });
});
