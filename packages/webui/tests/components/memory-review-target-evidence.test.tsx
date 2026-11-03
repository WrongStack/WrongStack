import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewQueue } from '../../src/components/MemoryManager/ReviewQueue.js';
import type { SageEntry } from '../../src/types/sage.js';

const translation = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock('@/i18n', () => ({ useAppTranslation: () => translation }));
vi.mock('@wrongstack/project-surfaces/lib/i18n', () => ({ useAppTranslation: () => translation }));
afterEach(cleanup);

// This package has no jest-dom matchers, so read the DOM directly.

function makeClient() {
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
  } as unknown as ComponentProps<typeof ReviewQueue>['client'];
  return { client, emit };
}

/** One pending "archive this" candidate targeting `targetMemoryId`. */
function mountWithTarget(targetMemoryId: string, target: SageEntry | null) {
  const { client, emit } = makeClient();
  render(
    <ReviewQueue
      active
      client={client}
      listCandidates={() =>
        emit('memory.sage.listCandidates', {
          candidates: [
            {
              id: 'c1',
              kind: 'memory_review',
              status: 'pending',
              suggestedAction: 'archive',
              targetMemoryId,
              text: 'Archive this memory?',
              createdAt: '2026-01-01T00:00:00.000Z',
              tags: [],
            },
          ],
        })
      }
      resolveCandidate={vi.fn()}
      resolveMemory={(id: string) => (id === targetMemoryId ? target : null)}
    />,
  );
}

function base(overrides: Partial<SageEntry> = {}): SageEntry {
  return {
    id: 'mem_target',
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    text: 'Target memory.',
    importance: 0.5,
    confidence: 0.5,
    freshness: 0.5,
    tags: [],
    anchors: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A candidate is a proposal ABOUT a memory, so the accept/keep decision turns
 * on evidence that lives on the target. The single most important piece is WHY
 * the target is stale: a demoted-by-verification memory may be restored by a
 * later passing check, while a manually retired one is a settled decision that
 * auto-verification will not reverse. Without the split, Accept is not
 * distinguishable from a permanent verdict.
 */
describe('ReviewQueue — candidate target evidence', () => {
  it('shows a failed-anchor-check stale reason, marking the target restorable', async () => {
    mountWithTarget('mem_target', base({ status: 'stale', staleReason: 'verification' }));
    await screen.findByText('Archive this memory?');
    const badge = await screen.findByTestId('candidate-stale-reason');
    expect(badge.getAttribute('data-stale-reason')).toBe('verification');
    expect(badge.textContent).toContain('activity:memoryManager.staleReasonVerification');
  });

  it('shows a manual retirement as a different, settled reason', async () => {
    mountWithTarget('mem_target', base({ status: 'stale', staleReason: 'manual' }));
    await screen.findByText('Archive this memory?');
    const badge = await screen.findByTestId('candidate-stale-reason');
    expect(badge.getAttribute('data-stale-reason')).toBe('manual');
    expect(badge.textContent).toContain('activity:memoryManager.staleReasonManual');
  });

  it('does not leak one stale reason into the other branch', async () => {
    // Guards the actual bug class: a shared label or a swapped ternary would
    // make a reversible demotion look like a permanent retirement.
    mountWithTarget('mem_target', base({ status: 'stale', staleReason: 'verification' }));
    await screen.findByText('Archive this memory?');
    const badge = await screen.findByTestId('candidate-stale-reason');
    expect(badge.textContent).not.toContain('staleReasonManual');
  });

  it('surfaces the usefulness counts that justify retiring the target', async () => {
    // Hygiene files review candidates keyed on injected-but-unused counts, so
    // the numbers behind the proposal have to be on screen.
    mountWithTarget('mem_target', base({ injectionCount: 40, useCount: 0 }));
    await screen.findByText('Archive this memory?');
    const counts = await screen.findByTestId('candidate-usefulness');
    expect(counts.textContent).toContain('40');
    expect(counts.textContent).toContain('0');
  });

  it('renders no evidence strip for a target carrying no signals', async () => {
    mountWithTarget('mem_target', base());
    await screen.findByText('Archive this memory?');
    expect(screen.queryByTestId('candidate-evidence')).toBeNull();
  });

  it('still renders the row when the target cannot be resolved', async () => {
    // The target may live outside the loaded page. The row must degrade to the
    // bare candidate rather than disappearing or throwing.
    mountWithTarget('mem_offpage', null);
    expect(await screen.findByText('Archive this memory?')).not.toBeNull();
    expect(screen.queryByTestId('candidate-evidence')).toBeNull();
  });
});
