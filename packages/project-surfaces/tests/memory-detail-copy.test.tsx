/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/host.js', () => ({
  useSurfaceHost: () => ({
    useScrollRestore: () => ({ current: null }),
    useValidityReview: () => null,
    useCompanionReview: () => null,
    apiFetch: vi.fn(),
  }),
  surfaceFetch: vi.fn(),
}));

import { MemoryDetail } from '../src/sage/MemoryDetail.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let origClipboard: Clipboard | undefined;

beforeEach(() => {
  origClipboard = navigator.clipboard;
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

describe('MemoryDetail clipboard copy guard', () => {
  it('suppresses copiedNotice when clipboard rejects and emits it on success', async () => {
    const onNotice = vi.fn();
    const memory = {
      id: 'mem-1',
      title: 'Test Memory',
      content: 'Body',
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      tags: [],
      anchors: [],
    } as never;

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('CLIPBOARD_DENIED');
        },
      },
    });

    await act(async () => {
      root!.render(
        <MemoryDetail
          memory={memory}
          relatedMemories={[]}
          graphEdges={[]}
          allMemories={[]}
          onEdit={() => {}}
          onDelete={() => {}}
          onNotice={onNotice}
        />,
      );
    });

    const copyBtn = container!.querySelector('button[aria-label*="copyId"]') as HTMLButtonElement;
    await act(async () => {
      copyBtn.click();
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(onNotice).not.toHaveBeenCalled();

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {},
      },
    });
    await act(async () => {
      copyBtn.click();
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(onNotice).toHaveBeenCalledTimes(1);
  });
});
