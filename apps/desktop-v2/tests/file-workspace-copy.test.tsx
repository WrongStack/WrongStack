/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileWorkspace } from '../src/FileWorkspace.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let origClipboard: Clipboard | undefined;

beforeEach(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
  }
  if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')?.get) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      value: 400,
    });
  }
  origClipboard = navigator.clipboard;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async () => {
        throw new Error('CLIPBOARD_DENIED');
      },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: origClipboard,
  });
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe('FileWorkspace clipboard error guard', () => {
  it('swallows clipboard rejection on context menu copy path without unhandledRejection', async () => {
    const command = async (type: string) => {
      if (type === 'files.tree')
        return { tree: [{ name: 'a.ts', path: 'a.ts', type: 'file', kind: 'file' }] };
      if (type === 'git.changes') return { changes: [] };
      if (type === 'files.read') return { content: 'hello\nworld', binary: false };
      return {};
    };

    await act(async () => {
      root!.render(
        <FileWorkspace
          scopeKey="/workspace"
          projectId="p1"
          command={command as never}
          send={async () => {}}
          state={{ connected: true, sessionId: 'sess-1', messages: [], results: {} } as never}
        />,
      );
    });
    await new Promise((r) => setTimeout(r, 20));

    const fileBtn = Array.from(container!.querySelectorAll('[role="treeitem"], button')).find((b) =>
      b.textContent?.includes('a.ts'),
    );
    expect(fileBtn).toBeDefined();
    await act(async () => {
      fileBtn!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });

    const copyBtn = Array.from(
      container!.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'),
    ).find(
      (b) => b.textContent?.toLowerCase().includes('copy') || b.textContent?.includes('copyPath'),
    );
    expect(copyBtn).toBeDefined();
    await act(async () => {
      copyBtn!.click();
    });
    await new Promise((r) => setTimeout(r, 15));
  });
});
