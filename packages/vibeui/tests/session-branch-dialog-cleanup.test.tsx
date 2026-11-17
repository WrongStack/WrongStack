/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionBranchDialog } from '../src/components/session-branch-dialog.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.useRealTimers();
});

describe('SessionBranchDialog listener and timer cleanup', () => {
  it('cleans up subscribe listener and 8s timeout when dialog closes while /tree is pending', async () => {
    let activeListeners = 0;

    const controller = {
      state: { id: 'sess-slow' },
      connection: 'open',
      send: () => true,
      subscribe: () => {
        activeListeners++;
        return () => {
          activeListeners--;
        };
      },
      switchSession: () => {},
      notice: () => {},
    } as never;

    await act(async () => {
      root!.render(
        <SessionBranchDialog open={true} onOpenChange={() => {}} controller={controller} />,
      );
    });
    expect(activeListeners).toBe(1);

    await act(async () => {
      root!.render(
        <SessionBranchDialog open={false} onOpenChange={() => {}} controller={controller} />,
      );
    });
    expect(activeListeners).toBe(0);
  });
});
