/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { ContextFeed } from '@wrongstack/project-surfaces/context/context-host';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineState } from '../src/engine-state.js';

let capturedFeed: ContextFeed | undefined;

vi.mock('../src/SurfaceFrame.js', () => ({
  SurfaceFrame: ({ host }: { host: { context?: ContextFeed } }) => {
    capturedFeed = host.context;
    return <div />;
  },
  useSurfaceConfirm: () => ({ confirm: async () => true }),
}));
vi.mock('@wrongstack/project-surfaces/context/ContextDashboard', () => ({
  ContextDashboard: () => <div />,
}));
vi.mock('../src/desktop-surface-host.js', () => ({
  desktopSurfaceHost: () => ({ host: {}, attach: () => () => {} }),
}));
vi.mock('../src/engine-stream.js', () => ({
  backendStream: () => ({}),
}));
vi.mock('../src/journal-tail.js', () => ({
  journalTail: () => ({}),
}));
vi.mock('../src/engine-http.js', () => ({
  projectHttp: () => async () => ({}),
}));

const { SessionContextDashboard } = await import('../src/SessionContextDashboard.js');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  capturedFeed = undefined;
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

describe('SessionContextDashboard requestDebug AbortSignal handling', () => {
  it('rejects immediately on a pre-aborted signal and removes its abort listener on settlement', async () => {
    let called = false;
    await act(async () => {
      root!.render(
        <SessionContextDashboard
          projectId="p1"
          projectRoot="/tmp"
          state={{ sessionId: 's1', connected: true } as unknown as EngineState}
          command={() => {
            called = true;
            return new Promise(() => {});
          }}
          onBack={() => {}}
        />,
      );
    });

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(capturedFeed!.requestDebug(preAborted.signal)).rejects.toThrow(
      'The context request was cancelled.',
    );
    expect(called).toBe(false);

    let activeListeners = 0;
    const trackedSignal = {
      aborted: false,
      addEventListener: () => {
        activeListeners++;
      },
      removeEventListener: () => {
        activeListeners--;
      },
    } as unknown as AbortSignal;

    await act(async () => {
      root!.render(
        <SessionContextDashboard
          projectId="p1"
          projectRoot="/tmp"
          state={{ sessionId: 's1', connected: true } as unknown as EngineState}
          command={async () => ({ total: 0, tools: { breakdown: [] }, messages: {} })}
          onBack={() => {}}
        />,
      );
    });
    await capturedFeed!.requestDebug(trackedSignal);
    expect(activeListeners).toBe(0);
  });
});
