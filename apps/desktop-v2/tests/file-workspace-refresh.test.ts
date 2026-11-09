// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { EngineCommand } from '../src/engine-operations';
import { emptyEngineState } from '../src/engine-state';
import { FileWorkspace } from '../src/FileWorkspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

afterEach(() => vi.useRealTimers());

function mountWorkspace(command: EngineCommand, scopeKey: string, strict = false) {
  const host = document.createElement('div');
  const root = createRoot(host);
  return {
    host,
    root,
    render: (revision: number) =>
      act(async () => {
        const view = createElement(FileWorkspace, {
          command,
          send: async () => {},
          state: {
            ...emptyEngineState,
            results: revision ? { 'files.tree.changed': { revision } } : {},
          },
          projectId: scopeKey,
          scopeKey,
        });
        root.render(strict ? createElement(StrictMode, null, view) : view);
      }),
  };
}

it('coalesces watcher bursts into one fresh follow-up without concurrent whole-tree reads', async () => {
  vi.useFakeTimers();
  const host = document.createElement('div');
  const root = createRoot(host);
  const reads: Array<(tree: string[]) => void> = [];
  let active = 0;
  let peak = 0;
  const command: EngineCommand = vi.fn(async (type) => {
    if (type !== 'files.tree') return { files: [] };
    active++;
    peak = Math.max(peak, active);
    return new Promise<Record<string, unknown>>((resolve) => {
      reads.push((paths) => {
        active--;
        resolve({ tree: paths.map((path) => ({ name: path, path, type: 'file' })) });
      });
    });
  });
  const render = async (revision: number) => {
    await act(async () => {
      root.render(
        createElement(FileWorkspace, {
          command,
          send: async () => {},
          state: {
            ...emptyEngineState,
            results: revision ? { 'files.tree.changed': { revision } } : {},
          },
          projectId: 'refresh-burst',
          scopeKey: 'D:/refresh-burst',
        }),
      );
    });
  };
  try {
    await render(0);
    await act(async () => reads[0]?.(['README.md']));
    expect(host.querySelector('[role="treeitem"][aria-label="README.md"]')).not.toBeNull();
    await render(1);
    await act(async () => vi.advanceTimersByTimeAsync(251));
    expect(reads).toHaveLength(2);
    await render(2);
    await act(async () => vi.advanceTimersByTimeAsync(251));
    await render(3);
    await act(async () => vi.advanceTimersByTimeAsync(251));
    expect(peak, 'only one backend traversal may be in flight for this view').toBe(1);
    await act(async () => reads[1]?.(['README.md']));
    expect(reads, 'all changes during the read need one fresh follow-up').toHaveLength(3);
    await act(async () => reads[2]?.(['README.md', 'latest.txt']));
    expect(host.querySelector('[role="treeitem"][aria-label="latest.txt"]')).not.toBeNull();
    expect(active).toBe(0);
  } finally {
    await act(async () => root.unmount());
  }
});

it('drops a queued follow-up when the file view closes', async () => {
  vi.useFakeTimers();
  let finish: ((value: Record<string, unknown>) => void) | undefined;
  const command: EngineCommand = vi.fn(async (type) => {
    if (type !== 'files.tree') return { files: [] };
    return new Promise<Record<string, unknown>>((resolve) => {
      finish = resolve;
    });
  });
  const view = mountWorkspace(command, 'D:/refresh-closed');
  try {
    await view.render(0);
    await view.render(1);
    await act(async () => vi.advanceTimersByTimeAsync(251));
    expect(vi.mocked(command).mock.calls.filter(([type]) => type === 'files.tree')).toHaveLength(1);
    await act(async () => view.root.unmount());
    await act(async () => finish?.({ tree: [] }));
    expect(vi.mocked(command).mock.calls.filter(([type]) => type === 'files.tree')).toHaveLength(1);
  } finally {
    await act(async () => view.root.unmount());
  }
});

it('keeps refresh usable after StrictMode effect cleanup and remount', async () => {
  vi.useFakeTimers();
  const command: EngineCommand = vi.fn(async (type) =>
    type === 'files.tree'
      ? { tree: [{ name: 'README.md', path: 'README.md', type: 'file' }] }
      : { files: [] },
  );
  const view = mountWorkspace(command, 'D:/refresh-strict', true);
  try {
    await view.render(0);
    expect(view.host.querySelector('[role="treeitem"][aria-label="README.md"]')).not.toBeNull();
    const before = vi.mocked(command).mock.calls.filter(([type]) => type === 'files.tree').length;
    await view.render(1);
    await act(async () => vi.advanceTimersByTimeAsync(251));
    expect(vi.mocked(command).mock.calls.filter(([type]) => type === 'files.tree').length).toBe(
      before + 1,
    );
    expect(view.host.querySelector('[role="treeitem"][aria-label="README.md"]')).not.toBeNull();
  } finally {
    await act(async () => view.root.unmount());
  }
});
