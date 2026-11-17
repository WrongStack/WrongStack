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

let sendGate = deferred<Response>();
const surfaceFetchMock = vi.fn((url: string, init?: RequestInit) => {
  if (url.endsWith('/message') && init?.method === 'POST') {
    return sendGate.promise;
  }
  if (url.includes('/api/sessions/sess-A/mailbox')) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          thread: [
            {
              id: 'tA',
              body: 'STALE_THREAD_FROM_A',
              from: 'leader',
              type: 'steer',
              priority: 'normal',
              subject: '',
              readByLeader: null,
              readByCount: 0,
              completed: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }
  if (url.includes('/api/sessions/sess-B/mailbox')) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          thread: [
            {
              id: 'tB',
              body: 'THREAD_B',
              from: 'leader',
              type: 'steer',
              priority: 'normal',
              subject: '',
              readByLeader: null,
              readByCount: 0,
              completed: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({
        session: { id: url.includes('sess-A') ? 'sess-A' : 'sess-B', status: 'running' },
        events: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
});

vi.mock('../src/host.js', async (orig) => {
  const actual = await orig<typeof import('../src/host.js')>();
  return {
    ...actual,
    surfaceFetch: (url: string, init?: RequestInit) => surfaceFetchMock(url, init),
  };
});

vi.mock('../src/office/feed.js', () => ({
  useOfficeFeed: () => ({
    useLiveSessions: () => [],
    useSnapshot: () => ({ sessions: [] }),
    useEvents: () => [],
    sendCommand: async () => ({}),
  }),
}));

const { SessionWatchPanel } = await import('../src/office/SessionWatchPanel.js');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  sendGate = deferred<Response>();
  surfaceFetchMock.mockClear();
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

describe('SessionWatchPanel send/interrupt session-switch guard', () => {
  it('ignores stale send() completion from an earlier sessionId after switching sessions', async () => {
    await act(async () => {
      root!.render(<SessionWatchPanel sessionId="sess-A" />);
    });

    const input = container!.querySelector('input[type="text"], textarea') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
      setter?.call(input, 'msg for A');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const sendBtn = Array.from(container!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('activity:sessionWatch.send'),
    );
    await act(async () => {
      sendBtn!.click();
    });

    await act(async () => {
      root!.render(<SessionWatchPanel sessionId="sess-B" />);
    });
    expect(container!.textContent).toContain('THREAD_B');

    const inputB = container!.querySelector('input[type="text"], textarea') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inputB), 'value')?.set;
      setter?.call(inputB, 'draft for B');
      inputB.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      sendGate.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });

    expect(container!.textContent).toContain('THREAD_B');
    expect(container!.textContent).not.toContain('STALE_THREAD_FROM_A');
    expect(inputB.value).toBe('draft for B');
  });
});
