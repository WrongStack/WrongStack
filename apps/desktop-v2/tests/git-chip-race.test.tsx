/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitChip } from '../src/GitChip.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.useRealTimers();
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe('GitChip poll sequence guard', () => {
  it('keeps fresh-branch when poll 1 resolves late', async () => {
    let resolvePoll1!: (v: unknown) => void;
    let resolvePoll2!: (v: unknown) => void;
    let calls = 0;

    const command = async () => {
      calls += 1;
      if (calls === 1) {
        return new Promise((r) => {
          resolvePoll1 = r;
        });
      }
      return new Promise((r) => {
        resolvePoll2 = r;
      });
    };

    await act(async () => {
      root!.render(<GitChip command={command as never} connected={true} />);
    });

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    await act(async () => {
      resolvePoll2({ isRepo: true, branch: 'fresh-branch', dirty: false, ahead: 0, behind: 0 });
    });
    await act(async () => {
      resolvePoll1({ isRepo: true, branch: 'stale-branch', dirty: false, ahead: 0, behind: 0 });
    });

    expect(container!.textContent).toContain('fresh-branch');
    expect(container!.textContent).not.toContain('stale-branch');
  });
});
