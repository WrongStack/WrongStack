/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let latestTransportOpts: {
  onMessage: (frame: { type: string; payload?: Record<string, unknown> }) => void;
  onState: (next: string) => void;
} | null = null;

vi.mock('../src/lib/transport.js', () => ({
  VibeTransport: class MockTransport {
    constructor(opts: typeof latestTransportOpts) {
      latestTransportOpts = opts;
    }
    async connect() {}
    send() {
      return true;
    }
    close() {}
  },
}));

const { useSession } = await import('../src/lib/use-session.js');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  latestTransportOpts = null;
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

describe('useSession compactPending cleanup', () => {
  it('clears compactPending and its 60s timeout on disconnect and session.start', async () => {
    let api!: ReturnType<typeof useSession>;
    function Harness() {
      api = useSession();
      return null;
    }

    await act(async () => {
      root!.render(<Harness />);
    });

    await act(async () => {
      latestTransportOpts!.onState('open');
      latestTransportOpts!.onMessage({
        type: 'session.start',
        payload: { id: 'sess-1', provider: 'openai', model: 'gpt-4o', running: false },
      });
    });

    await act(async () => {
      api.compactContext();
    });
    expect(api.compactPending).toBe(true);

    await act(async () => {
      latestTransportOpts!.onState('closed');
    });
    expect(api.compactPending).toBe(false);
  });
});
