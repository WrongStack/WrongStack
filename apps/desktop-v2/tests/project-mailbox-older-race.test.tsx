/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectMailbox } from '../src/ProjectMailbox.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

describe('ProjectMailbox loadOlder stale-sequence guard', () => {
  it('ignores stale loadOlder() rejection after a newer load() has refreshed the list', async () => {
    const olderGate = deferred<Record<string, unknown>>();
    let callCount = 0;

    const command = async (type: string, payload?: Record<string, unknown>) => {
      if (type === 'mailbox.agents') return { agents: [] };
      if (type === 'mailbox.messages') {
        callCount++;
        if (!payload?.until && callCount === 1) {
          return {
            messages: Array.from({ length: 100 }, (_, i) => ({
              id: `m-${i}`,
              from: 'a',
              to: 'b',
              subject: `hi ${i}`,
              body: 'body',
              timestamp: `2026-11-17T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
              read: true,
            })),
          };
        }
        if (payload?.until) {
          return olderGate.promise;
        }
        return {
          messages: [
            {
              id: 'm-fresh',
              from: 'a',
              to: 'b',
              subject: 'fresh',
              body: 'fresh',
              timestamp: '2026-11-17T01:00:00.000Z',
              read: true,
            },
          ],
        };
      }
      return {};
    };

    const state = {
      results: {},
      subscribe: () => () => {},
      getSnapshot: () => ({}),
    } as never;

    await act(async () => {
      root!.render(<ProjectMailbox command={command as never} projectId="proj-1" state={state} />);
    });

    const loadOlderBtn = Array.from(container!.querySelectorAll('button')).find((b) =>
      b.textContent?.toLowerCase().includes('older'),
    );
    expect(loadOlderBtn).toBeDefined();

    await act(async () => {
      loadOlderBtn!.click();
    });

    const refreshBtn = Array.from(container!.querySelectorAll('button')).find(
      (b) =>
        b.getAttribute('aria-label')?.toLowerCase().includes('refresh') ||
        b.textContent?.toLowerCase().includes('refresh'),
    );
    expect(refreshBtn).toBeDefined();

    await act(async () => {
      refreshBtn!.click();
    });

    await act(async () => {
      olderGate.reject(new Error('STALE_OLDER_ERROR'));
    });

    expect(container!.textContent ?? '').not.toContain('STALE_OLDER_ERROR');
  });
});
