// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorer } from '../src/file-explorer.js';
import type { SimpleSocket } from '../src/lib/ws.js';

const STORAGE_KEY = 'wrongstack-simpleui-file-manager-selected-file';
const roots: Root[] = [];

const tree = [
  {
    name: 'src',
    path: 'src',
    type: 'directory' as const,
    children: [{ name: 'app.ts', path: 'src/app.ts', type: 'file' as const }],
  },
  { name: 'README.md', path: 'README.md', type: 'file' as const },
];

class FakeSocket {
  readonly sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  private readonly listeners = new Set<(message: { type: string; payload?: unknown }) => void>();

  onMessage(listener: (message: { type: string; payload?: unknown }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(type: string, payload: Record<string, unknown> = {}): void {
    this.sent.push({ type, payload });
    const response =
      type === 'files.tree'
        ? { type: 'files.tree', payload: { tree } }
        : type === 'files.read'
          ? {
              type: 'files.read',
              payload: {
                filePath: payload['filePath'],
                content: `content:${String(payload['filePath'])}`,
              },
            }
          : null;
    if (response) {
      for (const listener of this.listeners) listener(response);
    }
  }
}

function renderExplorer(socket: FakeSocket): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(<FileExplorer socketRef={{ current: socket as unknown as SimpleSocket }} />);
  });
  return container;
}

function click(element: Element | null): void {
  if (!element) throw new Error('Expected clickable element');
  act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('FileExplorer', () => {
  it('opens with the file list and directory tree collapsed', async () => {
    const container = renderExplorer(new FakeSocket());

    click(container.querySelector('[aria-label="Open file manager"]'));
    // socketRequest resolves through a promise; flush microtasks so the
    // synchronous FakeSocket reply reaches component state.
    await act(async () => {});

    expect(
      container.querySelector('.file-manager-split')?.classList.contains('file-list-collapsed'),
    ).toBe(true);
    expect(container.querySelector('.file-explorer-body')).toBeNull();

    click(container.querySelector('[aria-label="Expand file list"]'));
    expect(container.querySelector('.file-explorer-body')).not.toBeNull();
    expect(container.textContent).toContain('src');
    expect(container.textContent).not.toContain('app.ts');
  });

  it('persists the selected file and restores it when the manager is mounted again', async () => {
    const firstSocket = new FakeSocket();
    const first = renderExplorer(firstSocket);

    click(first.querySelector('[aria-label="Open file manager"]'));
    await act(async () => {});
    click(first.querySelector('[aria-label="Expand file list"]'));
    click(
      Array.from(first.querySelectorAll('.file-tree-node')).find((node) =>
        node.textContent?.includes('src'),
      ) ?? null,
    );
    click(
      Array.from(first.querySelectorAll('.file-tree-node')).find((node) =>
        node.textContent?.includes('app.ts'),
      ) ?? null,
    );

    await act(async () => {});
    expect(localStorage.getItem(STORAGE_KEY)).toBe('src/app.ts');
    expect(first.textContent).toContain('content:src/app.ts');

    act(() => roots.shift()?.unmount());
    first.remove();

    const secondSocket = new FakeSocket();
    const second = renderExplorer(secondSocket);
    click(second.querySelector('[aria-label="Open file manager"]'));
    await act(async () => {});

    expect(
      second.querySelector('.file-manager-split')?.classList.contains('file-list-collapsed'),
    ).toBe(true);
    expect(second.textContent).toContain('content:src/app.ts');
    expect(secondSocket.sent).toContainEqual({
      type: 'files.read',
      payload: { filePath: 'src/app.ts' },
    });

    click(second.querySelector('[aria-label="Expand file list"]'));
    expect(second.textContent).toContain('app.ts');
    expect(second.querySelector('.file-tree-node.selected')?.textContent).toContain('app.ts');
  });
});
