/**
 * HQ Worktrees view: the persisted log through the shared timeline projector.
 *
 * @vitest-environment jsdom
 */
// React act() support: without this flag React warns "The current testing
// environment is not configured to support act(...)" on every act() call.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { HqEventEnvelope, HqWorktreeEventPayload } from '@wrongstack/hq';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const persisted: { events: HqEventEnvelope[] } = { events: [] };
vi.mock('../../src/data/api.js', () => ({
  // The API answers newest-first.
  fetchJson: vi.fn(async () => ({ events: [...persisted.events].reverse() })),
}));

const { useHqStore } = await import('../../src/data/store/index.js');
const { WorktreeView } = await import('../../src/views/worktree.js');

const T0 = Date.UTC(2026, 9, 5, 9, 0, 0);
let seq = 0;
function envelope(offsetMs: number, payload: HqWorktreeEventPayload): HqEventEnvelope {
  seq += 1;
  return {
    id: `ev-${seq}`,
    type: 'worktree.event',
    timestamp: new Date(T0 + offsetMs).toISOString(),
    clientId: 'c1',
    sessionId: 's1',
    payload,
  } as HqEventEnvelope;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  seq = 0;
  useHqStore.setState({ events: [] });
  const api = { handleId: 'api-1', ownerId: 'p1', branch: 'wstack/ap/api-1' };
  const db = { handleId: 'db-2', ownerId: 'p2', branch: 'wstack/ap/db-2' };
  persisted.events = [
    envelope(0, { kind: 'allocated', ...api, ownerLabel: 'API phase', baseBranch: 'main' }),
    envelope(1000, { kind: 'allocated', ...db, ownerLabel: 'DB phase', baseBranch: 'main' }),
    envelope(20_000, { kind: 'committed', ...api, insertions: 9, deletions: 2, files: 1 }),
    envelope(30_000, { kind: 'merging', ...api, baseBranch: 'main' }),
    envelope(31_000, { kind: 'merged', ...api, baseBranch: 'main', squash: true }),
    envelope(40_000, { kind: 'failed', ...db, error: 'lint-staged failed', stage: 'commit' }),
    envelope(40_100, { kind: 'released', ...db, kept: true }),
  ];
});

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<WorktreeView />);
  });
  await act(async () => {}); // let the backfill promise settle
  return container;
}

describe('HQ WorktreeView timeline', () => {
  it('projects the persisted log into lanes with phases, outcomes and base commits', async () => {
    const el = await mount();
    const lanes = [...el.querySelectorAll('[data-testid="worktree-lane"]')];
    expect(lanes.map((l) => l.getAttribute('data-outcome'))).toEqual(['merged', 'failed']);
    const phases = [...lanes[0]!.querySelectorAll('[data-phase]')].map((s) =>
      s.getAttribute('data-phase'),
    );
    expect(phases).toEqual(['working', 'queued', 'merging']);
    expect(el.querySelectorAll('[data-testid="worktree-base-commit"]')).toHaveLength(1);
    expect(el.textContent).toContain('need attention');
  });

  it('details the newest lane by default and switches on click', async () => {
    const el = await mount();
    let detail = el.querySelector('[data-testid="worktree-lane-detail"]')!;
    expect(detail.textContent).toContain('commit refused');
    expect(detail.textContent).toContain('lint-staged failed');
    expect(detail.querySelectorAll('[data-testid="worktree-event"]')).toHaveLength(3);

    const apiLane = el.querySelector('[data-outcome="merged"]') as HTMLButtonElement;
    await act(async () => apiLane.click());
    detail = el.querySelector('[data-testid="worktree-lane-detail"]')!;
    expect(detail.textContent).toContain('wstack/ap/api-1');
    expect(detail.querySelectorAll('[data-testid="worktree-event"]')).toHaveLength(4);
  });
});
