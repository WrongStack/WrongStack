/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_ATLAS, DesktopAtlasContext } from '../src/desktop-atlas-host.js';

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
      root?.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

async function flushMicrotasks(turns = 6) {
  for (let i = 0; i < turns; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('AtlasIndexControls job tracking and project-switch fencing', () => {
  const HeaderActions = DESKTOP_ATLAS.HeaderActions!;

  it('clears expectedJob after completion so subsequent builds and newer startedAt statuses are tracked', async () => {
    let statusReply: Record<string, unknown> = { status: 'ready', startedAt: 500 };
    const http = vi.fn(async (path: string, method?: string) => {
      if (path === '/api/codemap/index' && method === 'POST') return { startedAt: 1000 };
      return statusReply;
    });

    await act(async () => {
      root?.render(
        createElement(
          DesktopAtlasContext.Provider,
          {
            value: {
              projectRoot: '/repo',
              http: http as never,
              send: (async () => {}) as never,
              command: (async () => ({})) as never,
              state: {} as never,
            },
          },
          createElement(HeaderActions),
        ),
      );
    });
    await flushMicrotasks();

    // Start build 1 (startedAt: 1000) and complete it
    await act(async () => {
      container?.querySelector('button')?.click();
    });
    await flushMicrotasks();
    statusReply = { status: 'ready', startedAt: 1000 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(container?.querySelector('button')?.disabled).toBe(false);

    // Subsequent background build (startedAt: 2000) is observed instead of ignored
    statusReply = { status: 'indexing', startedAt: 2000 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(container?.querySelector('button')?.disabled).toBe(true);

    // Build 2 completes with a newer startedAt
    statusReply = { status: 'ready', startedAt: 2000 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(container?.querySelector('button')?.disabled).toBe(false);
  });

  it('resets state on project switch (http change) and ignores late POST completions from the old project', async () => {
    let resolveOldPost!: (v: Record<string, unknown>) => void;
    const oldHttp = vi.fn(async (path: string, method?: string) => {
      if (path === '/api/codemap/index' && method === 'POST') {
        return new Promise<Record<string, unknown>>((resolve) => {
          resolveOldPost = resolve;
        });
      }
      return { status: 'ready', startedAt: 100 };
    });
    const newHttp = vi.fn(async () => ({ status: 'ready', startedAt: 200 }));

    const renderWith = async (http: unknown) => {
      await act(async () => {
        root?.render(
          createElement(
            DesktopAtlasContext.Provider,
            {
              value: {
                projectRoot: '/repo',
                http: http as never,
                send: (async () => {}) as never,
                command: (async () => ({})) as never,
                state: {} as never,
              },
            },
            createElement(HeaderActions),
          ),
        );
      });
      await flushMicrotasks();
    };

    await renderWith(oldHttp);
    await act(async () => {
      container?.querySelector('button')?.click();
    });
    expect(container?.querySelector('button')?.disabled).toBe(true);

    // Switch project while old POST is still in flight
    await renderWith(newHttp);
    expect(container?.querySelector('button')?.disabled).toBe(false);

    // Late resolution from old project does not wedge new project
    resolveOldPost({ startedAt: 9999 });
    await flushMicrotasks();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(container?.querySelector('button')?.disabled).toBe(false);
  });
});
