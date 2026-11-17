/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let sendAckGate = deferred<void>();
let capturedOnMarkPermanent: ((id: string) => unknown) | undefined;

vi.mock('../src/host.js', async (orig) => {
  const actual = await orig<typeof import('../src/host.js')>();
  return {
    ...actual,
    useSurfaceHost: () => ({
      notify: { success: () => {}, error: () => {} },
      useScrollRestore: () => () => {},
      useNavigateBack: () => () => {},
    }),
  };
});

vi.mock('../src/sage/useMemoryManagerState.js', () => ({
  useMemoryManagerState: () => {
    const sample = {
      id: 'mem-1',
      text: 'test',
      content: 'test',
      kind: 'fact',
      persistence: 'session',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };
    return new Proxy(
      {
        memories: [sample],
        filteredMemories: [sample],
        allTags: [],
        loading: false,
        error: null,
        selectedMemory: sample,
        creating: false,
        editing: false,
        showReview: false,
        searchQuery: '',
        ranked: null,
        hasMore: false,
        activeFilterCount: 0,
        detailOpen: true,
        drawerOpen: true,
        drawerActive: true,
        currentFilePath: 'notes.md',
        drawerMode: 'drawer',
        activeTab: 'drawer',
        sendWithAck: () => sendAckGate.promise,
        updateSage: () => true,
        setMutationError: () => {},
        setNotice: () => {},
        loadMemories: () => {},
        openEdit: () => {},
        closeDrawer: () => {},
        setDrawerOpen: () => {},
        setSelectedMemory: () => {},
        setActiveTab: () => {},
        deleteDialogOpen: false,
        setDeleteDialogOpen: () => {},
        deleteTarget: null,
        setDeleteTarget: () => {},
        mutationError: null,
        notice: null,
        filters: { query: '', kind: 'all', scope: 'all', status: 'all' },
        setFilters: () => {},
        stats: null,
        reviewQueue: [],
        searchBreakdown: null,
        rankedResults: [],
        health: null,
        wsConnected: true,
      },
      {
        get(target, prop) {
          if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
          return () => {};
        },
      },
    );
  },
}));

vi.mock('../src/sage/MemoryDrawer.js', () => ({
  MemoryDrawer: (props: { onMarkPermanent?: (id: string) => unknown }) => {
    capturedOnMarkPermanent = props.onMarkPermanent;
    return <div data-testid="drawer" />;
  },
}));

const { MemoryManager } = await import('../src/sage/MemoryManager.js');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  sendAckGate = deferred<void>();
  capturedOnMarkPermanent = undefined;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe('MemoryManager onMarkPermanent promise return', () => {
  it('returns the sendWithAck promise so MemoryDrawer holds pending state until ack settles', async () => {
    await act(async () => {
      root!.render(<MemoryManager />);
    });

    const ret = capturedOnMarkPermanent!('mem-123');
    expect(ret).toBeInstanceOf(Promise);
    sendAckGate.resolve();
    await ret;
  });
});
