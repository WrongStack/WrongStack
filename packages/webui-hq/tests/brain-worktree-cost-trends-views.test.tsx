/** @vitest-environment jsdom */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHqStore } from '../src/store';
import { BrainView } from '../src/views/brain';
import { CostView } from '../src/views/cost';
import { TrendsView } from '../src/views/trends';
import { WorktreeView } from '../src/views/worktree';

const jsonResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response;

const pendingFetch = () => new Promise<Response>(() => undefined);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(element);
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  useHqStore.setState(useHqStore.getInitialState());
});

describe('BrainView', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ events: [] })));
    useHqStore.setState({ events: [] });
  });

  it('renders the initial loading state while brain history is backfilled', () => {
    const fetch = vi.fn(pendingFetch);
    vi.stubGlobal('fetch', fetch);

    mount(createElement(BrainView));

    expect(fetch).toHaveBeenCalledWith('/api/events?type=brain.event&limit=200', expect.any(Object));
    expect(container?.textContent).toContain('Loading brain history…');
  });

  it('renders the empty state after backfill completes with no decisions', async () => {
    mount(createElement(BrainView));
    await flushPromises();

    expect(container?.textContent).toContain('No brain decisions yet');
  });
});

describe('WorktreeView', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ events: [] })));
    useHqStore.setState({ events: [] });
  });

  it('renders the initial loading state while worktree history is backfilled', () => {
    const fetch = vi.fn(pendingFetch);
    vi.stubGlobal('fetch', fetch);

    mount(createElement(WorktreeView));

    expect(fetch).toHaveBeenCalledWith('/api/events?type=worktree.event&limit=300', expect.any(Object));
    expect(container?.textContent).toContain('Loading worktree history…');
  });

  it('renders the empty state after backfill completes with no worktree events', async () => {
    mount(createElement(WorktreeView));
    await flushPromises();

    expect(container?.textContent).toContain('No worktree events yet');
  });
});

describe('CostView', () => {
  beforeEach(() => {
    useHqStore.setState({ snapshot: null });
  });

  it('renders the empty state when no cost data is available', () => {
    mount(createElement(CostView));
    expect(container?.textContent).toContain('No cost data yet');
  });
});

describe('TrendsView', () => {
  it('renders the empty state after cost trend fetch returns no samples', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ samples: [] })));

    mount(createElement(TrendsView));
    await flushPromises();

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/trends/cost', expect.any(Object));
    expect(container?.textContent).toContain('No trend data yet');
  });

  it('renders the error state when cost trend fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('bad metrics')));

    mount(createElement(TrendsView));
    await flushPromises();

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/trends/cost', expect.any(Object));
    expect(container?.textContent).toContain('Error loading trends: Network error fetching /api/trends/cost');
  });
});
