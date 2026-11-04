import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewQueue } from '../../src/components/MemoryManager/ReviewQueue.js';

const translation = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock('@/i18n', () => ({ useAppTranslation: () => translation }));
vi.mock('@wrongstack/project-surfaces/lib/i18n', () => ({ useAppTranslation: () => translation }));
afterEach(cleanup);

function mount(actions: string[]) {
  const handlers = new Map<string, Set<(message: unknown) => void>>();
  const candidates = actions.map((suggestedAction, i) => ({
    id: `c${i}`,
    kind: 'memory_review',
    status: 'pending',
    suggestedAction,
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
  const resolveCandidate = vi.fn(
    ({ candidateId, action }: { candidateId: string; action: string }) => {
      emit('memory.sage.candidateResolve', {
        candidate: { id: candidateId },
        resolvedAction: action,
      });
    },
  );
  const onOpenMemory = vi.fn();
  render(
    <ReviewQueue
      active
      client={client}
      listCandidates={() => emit('memory.sage.listCandidates', { candidates })}
      resolveCandidate={resolveCandidate}
      onOpenMemory={onOpenMemory}
    />,
  );
  return { resolveCandidate, onOpenMemory };
}

describe('advisory memory reviews', () => {
  it('offers inspection and keep, but no deletion acceptance for investigate', async () => {
    const { onOpenMemory, resolveCandidate } = mount(['investigate']);
    fireEvent.click(await screen.findByRole('button', { name: 'common:action.open' }));
    expect(onOpenMemory).toHaveBeenCalledWith('memory-0');
    expect(
      screen.queryByRole('button', { name: 'activity:memoryManager.actionAcceptDeletion' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(
      screen
        .getByRole('button', { name: 'activity:memoryManager.reviewBulkAccept' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(resolveCandidate).not.toHaveBeenCalled();
  });

  it('excludes investigate/update from mixed bulk acceptance', async () => {
    const { resolveCandidate } = mount(['investigate', 'update', 'delete']);
    fireEvent.click(
      await screen.findByRole('button', { name: 'activity:memoryManager.reviewSelectAll' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'activity:memoryManager.reviewBulkAccept (1)' }),
    );
    await waitFor(() => expect(resolveCandidate).toHaveBeenCalledTimes(1));
    expect(resolveCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: 'c2', action: 'accept' }),
      { echoToChat: false },
    );
  });
});
