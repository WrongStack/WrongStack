/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('../src/host.js', () => ({
  surfaceFetch: fetchMock,
  useSurfaceHost: () => ({
    useTranslation: () => ({
      t: (_k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _k,
    }),
  }),
}));

vi.mock('../src/office/feed.js', () => ({
  useOfficeFeed: () => ({
    useLiveSessions: () => [],
    useSnapshot: () => ({ sessions: [] }),
    useEvents: () => [],
    sendCommand: async () => ({}),
  }),
}));

const { SessionWatchPanel } = await import('../src/office/SessionWatchPanel.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  fetchMock.mockReset();
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

describe('SessionWatchPanel session switch race', () => {
  it('ignores stale responses from an earlier sessionId after switching sessions', async () => {
    const reqA = deferred<Response>();
    const reqB = deferred<Response>();

    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/sessions/A/events')) return reqA.promise;
      if (url.includes('/sessions/B/events')) return reqB.promise;
      return Promise.resolve({ ok: true, json: async () => ({ thread: [] }) } as Response);
    });

    await act(async () => {
      root!.render(<SessionWatchPanel sessionId="A" />);
    });
    await act(async () => {
      root!.render(<SessionWatchPanel sessionId="B" />);
    });

    await act(async () => {
      reqB.resolve({
        ok: true,
        json: async () => ({
          sessionId: 'B',
          status: 'running',
          total: 1,
          entries: [{ ts: new Date().toISOString(), role: 'assistant', text: 'SESSION-B-EVENT' }],
        }),
      } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container!.textContent).toContain('SESSION-B-EVENT');

    await act(async () => {
      reqA.resolve({
        ok: true,
        json: async () => ({
          sessionId: 'A',
          status: 'running',
          total: 1,
          entries: [{ ts: new Date().toISOString(), role: 'assistant', text: 'STALE-A-EVENT' }],
        }),
      } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container!.textContent).toContain('SESSION-B-EVENT');
    expect(container!.textContent).not.toContain('STALE-A-EVENT');
  });
});
