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
 * Mount the queue with `delete` review candidates. `respond` decides what the
 * fake server sends back for each resolve request (or nothing, to hold it).
 */
function mount(
  count: number,
  respond: (opts: ResolveOpts, emit: (payload: unknown) => void) => void,
) {
  const handlers = new Map<string, Set<(message: unknown) => void>>();
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
  const emit = (type: string, payload: unknown) => {
    for (const callback of [...(handlers.get(type) ?? [])]) callback({ type, payload });
  };
  const client = {
    on(type: string, callback: (message: unknown) => void) {
      const listeners = handlers.get(type) ?? new Set();
      listeners.add(callback);
      handlers.set(type, listeners);
      return () => listeners.delete(callback);
    },
  } as unknown as ComponentProps<typeof ReviewQueue>['client'];
  const resolveCandidate = vi.fn((opts: ResolveOpts) =>
    respond(opts, (payload) => emit('memory.sage.candidateResolve', payload)),
  );
  const view = render(
    <ReviewQueue
      active
      client={client}
      listCandidates={() => emit('memory.sage.listCandidates', { candidates })}
      resolveCandidate={resolveCandidate}
    />,
  );
  return { resolveCandidate, emit, view };
}

describe('ReviewQueue resolve outcomes', () => {
  it('surfaces a failed accept on its row instead of looking successful', async () => {
    mount(1, (opts, emit) => emit({ error: 'store is read-only', requestId: opts.requestId }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'activity:memoryManager.actionAcceptDeletion' }),
    );
    const failure = await screen.findByTestId('candidate-failure');
    expect(failure.textContent).toContain('activity:memoryManager.reviewActionFailed');
    expect(failure.textContent).toContain('store is read-only');
  });

  it('settles each wait on its own requestId, ignoring other replies', async () => {
    const held: { opts?: ResolveOpts } = {};
    const { emit } = mount(1, (opts) => {
      held.opts = opts;
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'activity:memoryManager.actionAcceptDeletion' }),
    );
    expect(held.opts?.requestId).toMatch(/^review_/);
    // A reply to a different request (another tab/row) must not settle this one.
    act(() => emit('memory.sage.candidateResolve', { error: 'other', requestId: 'someone-else' }));
    expect(screen.queryByTestId('candidate-failure')).toBeNull();
    // Our own failure reply does.
    act(() =>
      emit('memory.sage.candidateResolve', { error: 'mine', requestId: held.opts?.requestId }),
    );
    const failure = await screen.findByTestId('candidate-failure');
    expect(failure.textContent).toContain('mine');
    expect(failure.textContent).not.toContain('other');
  });

  it('reports bulk failures and keeps only the failed rows selected', async () => {
    mount(3, (opts, emit) =>
      emit(
        opts.candidateId === 'c1'
          ? { error: 'nope', requestId: opts.requestId }
          : { candidate: { id: opts.candidateId }, requestId: opts.requestId },
      ),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'activity:memoryManager.reviewSelectAll' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'activity:memoryManager.reviewBulkAccept (3)' }),
    );
    const banner = await screen.findByText(/activity:memoryManager\.reviewBulkFailed/);
    expect(banner.textContent).toContain('"failed":1');
    expect(banner.textContent).toContain('"total":3');
    await waitFor(() => {
      const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
      expect(boxes.map((box) => box.checked)).toEqual([false, true, false]);
    });
    expect(screen.getAllByTestId('candidate-failure')).toHaveLength(1);
  });

  it('clears its 15s timers once responses arrive', async () => {
    const timers = new Set<unknown>();
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      const id = realSetTimeout(fn, ms, ...rest);
      if (ms === 15_000) timers.add(id);
      return id;
    }) as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    mount(1, (opts, emit) =>
      emit({ candidate: { id: opts.candidateId }, requestId: opts.requestId }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'activity:memoryManager.actionAcceptDeletion' }),
    );
    await waitFor(() => expect(timers.size).toBeGreaterThanOrEqual(3));
    const cleared = new Set(clearSpy.mock.calls.map((call) => call[0]));
    for (const id of timers) expect(cleared.has(id as never)).toBe(true);
  });

  it('cancels an in-flight resolve timer on unmount', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { view } = mount(1, () => {});
    fireEvent.click(
      await screen.findByRole('button', { name: 'activity:memoryManager.actionAcceptDeletion' }),
    );
    const before = clearSpy.mock.calls.length;
    view.unmount();
    expect(clearSpy.mock.calls.length).toBeGreaterThan(before);
  });
});
