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

vi.mock('../src/platform.js', () => ({
  openExternal: async () => {},
}));

const { McpAuthorization } = await import('../src/McpAuthorization.js');

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

describe('McpAuthorization post-read token guard', () => {
  it('ignores stale mcp.auth.status reply after stopWaiting', async () => {
    let statusCalls = 0;
    const pollGate = deferred<Record<string, unknown>>();

    const command = async (type: string) => {
      if (type === 'mcp.auth.status') {
        statusCalls++;
        if (statusCalls === 1) return { state: 'not_authorized' };
        return pollGate.promise;
      }
      if (type === 'mcp.auth.login') {
        return {
          authorizationUrl: 'https://auth.example.com/oauth',
          expiresAt: Date.now() + 60_000,
        };
      }
      return {};
    };

    await act(async () => {
      root!.render(<McpAuthorization name="srv-1" command={command as never} />);
    });
    const details = container!.querySelector('details') as HTMLDetailsElement;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });

    const signInBtn = Array.from(container!.querySelectorAll('button')).find((b) =>
      b.textContent?.toLowerCase().includes('sign in'),
    )!;
    await act(async () => {
      signInBtn.click();
    });
    for (let i = 0; i < 10 && statusCalls < 2; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
    }
    expect(statusCalls).toBe(2);

    const stopBtn = Array.from(container!.querySelectorAll('button')).find((b) =>
      b.textContent?.toLowerCase().includes('stop waiting'),
    )!;
    await act(async () => {
      stopBtn.click();
    });

    await act(async () => {
      pollGate.resolve({ state: 'authorized' });
    });

    const lower = (container!.textContent ?? '').toLowerCase();
    expect(
      lower.includes('authorized') ||
        (lower.includes('signed in') && !lower.includes('not signed in')),
    ).toBe(false);
  });
});
