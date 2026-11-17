/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionBranchPill } from '../src/session-tree/SessionBranchPill.js';

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
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe('SessionBranchPill unhandled rejection guard', () => {
  it('swallows rejections across create, switch, and fold while still calling onRefresh', async () => {
    const onRefresh = vi.fn();
    const onCreateBranch = vi.fn().mockRejectedValue(new Error('CREATE_REJECTED'));
    const onSwitchBranch = vi.fn().mockRejectedValue(new Error('SWITCH_REJECTED'));
    const onFoldBranch = vi.fn().mockRejectedValue(new Error('FOLD_REJECTED'));

    const tree = {
      activeBranchId: 'b1',
      branches: [
        {
          id: 'b1',
          name: 'main',
          headEntryId: 'e1',
          depth: 0,
          entryCount: 3,
          forkSeq: 0,
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'b2',
          name: 'feature',
          headEntryId: 'e2',
          depth: 1,
          entryCount: 2,
          forkSeq: 1,
          createdAt: '2026-01-01T00:00:01Z',
        },
      ],
    } as never;

    await act(async () => {
      root!.render(
        <SessionBranchPill
          tree={tree}
          onCreateBranch={onCreateBranch}
          onSwitchBranch={onSwitchBranch}
          onFoldBranch={onFoldBranch}
          onRefresh={onRefresh}
        />,
      );
    });

    const toggleBtn = container!.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      toggleBtn.click();
    });

    const input = container!.querySelector(
      'input[type="text"], input:not([type="checkbox"])',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'topic');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = input.closest('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const switchBtn = Array.from(container!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('feature'),
    );
    expect(switchBtn).toBeDefined();
    await act(async () => {
      switchBtn!.click();
    });

    await act(async () => {
      toggleBtn.click();
    });
    const foldBtn = Array.from(container!.querySelectorAll('button')).find((b) =>
      b.title?.toLowerCase().includes('fold'),
    );
    if (foldBtn) {
      await act(async () => {
        foldBtn.click();
      });
    }

    await new Promise((r) => setTimeout(r, 15));
    expect(onCreateBranch).toHaveBeenCalledTimes(1);
    expect(onSwitchBranch).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalled();
  });
});
