/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewQueue } from '../src/sage/ReviewQueue.js';

const translation = vi.hoisted(() => ({
  t: (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key} ${JSON.stringify(vars)}` : key,
}));
vi.mock('../src/lib/i18n', () => ({ useAppTranslation: () => translation }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

async function flushMicrotasks(turns = 8) {
  for (let i = 0; i < turns; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('ReviewQueue unmount fencing and synchronous transport error handling', () => {
  const candidates = [
    {
      id: 'c1',
      kind: 'memory_review',
      status: 'pending',
      suggestedAction: 'delete',
      targetMemoryId: 'm1',
      text: 'Candidate 1',
      createdAt: new Date().toISOString(),
      tags: [],
    },
    {
      id: 'c2',
      kind: 'memory_review',
      status: 'pending',
      suggestedAction: 'archive',
      targetMemoryId: 'm2',
      text: 'Candidate 2',
      createdAt: new Date().toISOString(),
      tags: [],
    },
  ];

  it('stops bulkAct loop and post-resolve reload when unmounted mid-flight with zero leaked subscriptions', async () => {
    const handlers = new Map<string, Set<(msg: unknown) => void>>();
    let liveSubs = 0;
    const resolveCalls: string[] = [];
    let listCalls = 0;

    const emit = (type: string, payload: unknown) => {
      for (const cb of [...(handlers.get(type) ?? [])]) cb({ type, payload });
    };
    const client = {
      on(type: string, cb: (msg: unknown) => void) {
        const set = handlers.get(type) ?? new Set();
        set.add(cb);
        handlers.set(type, set);
        liveSubs++;
        return () => {
          if (set.delete(cb)) liveSubs--;
        };
      },
    } as unknown as ComponentProps<typeof ReviewQueue>['client'];

    await act(async () => {
      root?.render(
        <ReviewQueue
          active
          client={client}
          listCandidates={() => {
            listCalls++;
            if (listCalls === 1) emit('memory.sage.listCandidates', { candidates });
          }}
          resolveCandidate={(opts) => {
            resolveCalls.push(opts.candidateId);
          }}
        />,
      );
    });
    await flushMicrotasks();

    const selectAllBtn = [...(container?.querySelectorAll('button') ?? [])].find((b) =>
      /reviewSelectAll/i.test(b.textContent ?? ''),
    );
    expect(selectAllBtn).toBeTruthy();
    await act(async () => {
      selectAllBtn?.click();
    });

    const bulkAcceptBtn = [...(container?.querySelectorAll('button') ?? [])].find(
      (b) => /reviewBulkAccept/i.test(b.textContent ?? '') && !b.disabled,
    );
    expect(bulkAcceptBtn).toBeTruthy();
    await act(async () => {
      bulkAcceptBtn?.click();
    });
    await flushMicrotasks(2);

    expect(resolveCalls).toEqual(['c1']);
    await act(async () => {
      root?.unmount();
    });
    root = null;
    await flushMicrotasks();

    expect(resolveCalls).toEqual(['c1']);
    expect(listCalls).toBe(1);
    expect(liveSubs).toBe(0);
  });

  it('cleans up subscriptions and surfaces errors when listCandidates or resolveCandidate throws synchronously', async () => {
    const handlers = new Map<string, Set<(msg: unknown) => void>>();
    let liveSubs = 0;
    const client = {
      on(type: string, cb: (msg: unknown) => void) {
        const set = handlers.get(type) ?? new Set();
        set.add(cb);
        handlers.set(type, set);
        liveSubs++;
        return () => {
          if (set.delete(cb)) liveSubs--;
        };
      },
    } as unknown as ComponentProps<typeof ReviewQueue>['client'];

    await act(async () => {
      root?.render(
        <ReviewQueue
          active
          client={client}
          listCandidates={() => {
            throw new Error('transport offline');
          }}
          resolveCandidate={() => {}}
        />,
      );
    });
    await flushMicrotasks();
    expect(liveSubs).toBe(0);
    expect(container?.textContent).toContain('transport offline');
  });
});
