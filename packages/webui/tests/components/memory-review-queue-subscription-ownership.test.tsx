/**
 * Regression test for the WebUI ReviewQueue's subscription ownership.
 *
 * `load()` returns a cleanup, but only the effect ever registered it. Every
 * other caller - `act()`, `bulkAct()` and the refresh button - called `load()`
 * directly and discarded that cleanup, so the `memory.sage.listCandidates`
 * subscription and its 15 s timer outlived the component when the operator
 * left the Review tab.
 *
 * See: packages/webui/src/components/MemoryManager/ReviewQueue.tsx
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewQueue } from '../../src/components/MemoryManager/ReviewQueue.js';

const translation = vi.hoisted(() => ({
  t: (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key} ${JSON.stringify(vars)}` : key,
}));
vi.mock('@/i18n', () => ({ useAppTranslation: () => translation }));
vi.mock('@wrongstack/project-surfaces/lib/i18n', () => ({ useAppTranslation: () => translation }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type ResolveOpts = { candidateId: string; action: string; requestId?: string };

/**
 * Mount the queue with `count` review candidates.
 *
 * `respondToLoads`  how many list requests the fake server answers.
 * `respondToResolve` whether resolves are answered.
 */
function mount(options: { count?: number; respondToLoads: number; respondToResolve: boolean }) {
  const handlers = new Map<string, Set<(message: unknown) => void>>();
  /** Live subscriptions, per message type. */
  const live = new Map<string, number>();
  const count = options.count ?? 1;
  const candidates = Array.from({ length: count }, (_, i) => ({
    id: `c${i}`,
    kind: 'memory_review',
    status: 'pending',
    suggestedAction: 'delete',
    targetMemoryId: `memory-${i}`,
    text: `Review ${i}`,
    createdAt: new Date().toISOString(),
    tags: [],
  }));
  let loadsSeen = 0;

  const emit = (type: string, payload: unknown) => {
    for (const callback of [...(handlers.get(type) ?? [])]) callback({ type, payload });
  };
  const client = {
    on(type: string, callback: (message: unknown) => void) {
      const listeners = handlers.get(type) ?? new Set();
      listeners.add(callback);
      handlers.set(type, listeners);
      live.set(type, (live.get(type) ?? 0) + 1);
      return () => {
        if (listeners.delete(callback)) live.set(type, (live.get(type) ?? 1) - 1);
      };
    },
  } as unknown as ComponentProps<typeof ReviewQueue>['client'];

  const listCandidates = vi.fn(() => {
    loadsSeen += 1;
    if (loadsSeen <= options.respondToLoads) {
      emit('memory.sage.listCandidates', { candidates });
    }
  });
  const resolveCandidate = vi.fn((opts: ResolveOpts) => {
    if (!options.respondToResolve) return;
    emit('memory.sage.candidateResolve', {
      candidate: { id: opts.candidateId },
      requestId: opts.requestId,
    });
  });

  const view = render(
    <ReviewQueue
      active
      client={client}
      listCandidates={listCandidates}
      resolveCandidate={resolveCandidate}
    />,
  );

  const liveSubscriptions = () => [...live.values()].reduce((sum, n) => sum + n, 0);
  return { liveSubscriptions, view };
}

describe('MemoryManager · ReviewQueue subscription ownership', () => {
  it('releases every WebSocket subscription when the queue unmounts', async () => {
    const { liveSubscriptions, view } = mount({ respondToLoads: 1, respondToResolve: true });

    fireEvent.click(
      await screen.findByRole('button', { name: 'activity:memoryManager.actionAcceptDeletion' }),
    );
    // The resolve settled and the queue reloaded; that reload is held, so its
    // subscription only disappears if it is released.
    await waitFor(() => expect(liveSubscriptions()).toBeGreaterThan(0));

    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(liveSubscriptions()).toBe(0);
  });

  it('releases the load timer of an unanswered request on unmount', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { liveSubscriptions, view } = mount({ respondToLoads: 0, respondToResolve: false });

    await waitFor(() => expect(liveSubscriptions()).toBeGreaterThan(0));
    const clearedBefore = clearSpy.mock.calls.length;
    view.unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(liveSubscriptions()).toBe(0);
    expect(clearSpy.mock.calls.length).toBeGreaterThan(clearedBefore);
  });
});
