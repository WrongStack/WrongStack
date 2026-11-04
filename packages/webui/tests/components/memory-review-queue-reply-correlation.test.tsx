/**
 * Regression test for candidate-resolve reply correlation in the WebUI.
 *
 * `ReviewQueue.resolveOne()` always sends a `requestId` and the server always
 * echoes it, so only the reply carrying exactly that id may settle the wait.
 * The guard used to accept a reply that carried NO id - which is what the
 * Memory Manager's file drawer produces, because it resolves candidates
 * without a correlation id. A foreign reply then settled the row's wait: the
 * row was marked failed (or successful) for an action it never performed and
 * the row's own reply was dropped when it finally arrived.
 *
 * `useSendWithAck` matches the other way round: a reply tagged with another
 * request's id must not settle its wait either.
 *
 * See: packages/webui/src/components/MemoryManager/ReviewQueue.tsx
 *       packages/webui/src/components/MemoryManager/useSendWithAck.ts
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ComponentProps, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewQueue } from '../../src/components/MemoryManager/ReviewQueue.js';
import { useSendWithAck } from '../../src/components/MemoryManager/useSendWithAck.js';

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

function mount(count = 1) {
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

  let sent: ResolveOpts | undefined;
  const resolveCandidate = vi.fn((opts: ResolveOpts) => {
    sent = opts;
  });

  const view = render(
    <ReviewQueue
      active
      client={client}
      listCandidates={() => emit('memory.sage.listCandidates', { candidates })}
      resolveCandidate={resolveCandidate}
    />,
  );
  return { emit, view, sentRequest: () => sent };
}

describe('MemoryManager · candidate resolve correlation', () => {
  it('ignores a candidateResolve reply that carries no requestId', async () => {
    const { emit, sentRequest } = mount();

    fireEvent.click(
      await screen.findByRole('button', { name: 'activity:memoryManager.actionAcceptDeletion' }),
    );
    expect(sentRequest()?.requestId).toMatch(/^review_/);

    // The Memory Manager's file drawer resolves candidates without a
    // correlation id, so the server's reply for it carries none either.
    act(() => emit('memory.sage.candidateResolve', { error: 'Candidate not found.' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId('candidate-failure')).toBeNull();
    expect(
      (
        screen.getByRole('button', {
          name: 'activity:memoryManager.actionAcceptDeletion',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('settles the wait on the reply carrying its own requestId', async () => {
    const { emit, sentRequest } = mount();

    fireEvent.click(
      await screen.findByRole('button', { name: 'activity:memoryManager.actionAcceptDeletion' }),
    );
    const requestId = sentRequest()?.requestId;
    expect(requestId).toMatch(/^review_/);

    act(() => emit('memory.sage.candidateResolve', { error: 'mine', requestId }));
    const failure = await screen.findByTestId('candidate-failure');
    expect(failure.textContent).toContain('mine');
  });

  it('useSendWithAck ignores a reply tagged with a different requestId', async () => {
    const handlers = new Map<string, Set<(message: unknown) => void>>();
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
    } as unknown as Parameters<typeof useSendWithAck>[0]['client'];

    const outcomes: string[] = [];

    function Harness() {
      const [error, setError] = useState<string | null>(null);
      const generationRef = useRef(0);
      const cleanupRef = useRef<(() => void) | null>(null);
      const mountedRef = useRef(true);
      const sendWithAck = useSendWithAck({
        client,
        mutationGenerationRef: generationRef,
        mutationCleanupRef: cleanupRef,
        mountedRef,
        setMutationError: setError,
      });
      return (
        <div>
          <button
            type="button"
            onClick={() =>
              sendWithAck(
                'memory.sage.candidateResolve',
                (requestId) => {
                  outcomes.push(requestId);
                },
                (payload) => {
                  outcomes.push(`settled:${String(payload.error ?? 'ok')}`);
                },
              )
            }
          >
            send
          </button>
          {error ? <span role="alert">{error}</span> : null}
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    await waitFor(() => expect(outcomes.length).toBeGreaterThan(0));
    const requestId = outcomes[0];
    expect(requestId).toMatch(/^ack_/);

    // A reply tagged with ANOTHER request's id must not settle this wait.
    act(() =>
      emit('memory.sage.candidateResolve', { candidate: { id: 'other' }, requestId: 'nope' }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(outcomes.some((entry) => entry.startsWith('settled:'))).toBe(false);

    // The matching reply does.
    act(() => emit('memory.sage.candidateResolve', { candidate: { id: 'x' }, requestId }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(outcomes.some((entry) => entry.startsWith('settled:'))).toBe(true);
  });
});
