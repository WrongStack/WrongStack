/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectLiveFleet } from '../src/ProjectLiveFleet.js';
import { surfaceI18n } from '../src/surface-i18n.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSession(id: string, projectRoot: string, agentName: string) {
  return {
    sessionId: id,
    projectRoot,
    status: 'active',
    pid: 100,
    startedAt: '2026-11-04T10:00:00Z',
    lastHeartbeatAt: '2026-11-04T10:01:00Z',
    agents: [
      {
        id: `agent-${id}`,
        name: agentName,
        status: 'running',
        iterations: 1,
        toolCalls: 1,
      },
    ],
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  await surfaceI18n.changeLanguage('en');
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

afterAll(() => surfaceI18n.changeLanguage('en'));

describe('ProjectLiveFleet project/carrier switch pending guard', () => {
  it('immediately polls the new project on switch and ignores out-of-order settlement of the old project request', async () => {
    const gateA = deferred<unknown[]>();
    const gateB = deferred<unknown[]>();
    const requested: string[] = [];

    await act(async () => {
      root!.render(
        <ProjectLiveFleet
          http={
            (async (path: string) => {
              if (path === '/api/sessions') {
                requested.push('proj-a');
                return gateA.promise;
              }
              return {};
            }) as never
          }
          projectRoot="C:/proj-a"
          carrierId="carrier-a"
          nativeSessions={[]}
        />,
      );
    });

    await act(async () => {
      root!.render(
        <ProjectLiveFleet
          http={
            (async (path: string) => {
              if (path === '/api/sessions') {
                requested.push('proj-b');
                return gateB.promise;
              }
              return {};
            }) as never
          }
          projectRoot="C:/proj-b"
          carrierId="carrier-b"
          nativeSessions={[]}
        />,
      );
    });

    expect(requested).toEqual(['proj-a', 'proj-b']);
    const refreshBtn = container!.querySelector('header button') as HTMLButtonElement;
    expect(refreshBtn.disabled).toBe(true);

    // Release stale Project A first while Project B is still in flight
    await act(async () => {
      gateA.resolve([makeSession('s-a', 'C:/proj-a', 'alpha-agent')]);
    });
    expect(container!.textContent).not.toContain('alpha-agent');
    expect(refreshBtn.disabled).toBe(true);

    await act(async () => {
      gateB.resolve([makeSession('s-b', 'C:/proj-b', 'bravo-agent')]);
    });
    await act(async () => {});
    expect(container!.textContent).toContain('bravo-agent');
    expect(refreshBtn.disabled).toBe(false);
  });

  it('evicts stale previous-project sessions and drops late errors across switches and empty carrierId', async () => {
    let callsA = 0;
    const gateARefresh = deferred<unknown[]>();
    const gateB = deferred<unknown[]>();

    await act(async () => {
      root!.render(
        <ProjectLiveFleet
          http={
            (async (path: string) => {
              if (path === '/api/sessions') {
                callsA += 1;
                return callsA === 1
                  ? [makeSession('s-a', 'C:/proj-a', 'alpha-agent')]
                  : gateARefresh.promise;
              }
              return {};
            }) as never
          }
          projectRoot="C:/proj-a"
          carrierId="carrier-a"
          nativeSessions={[]}
        />,
      );
    });
    await act(async () => {});
    expect(container!.textContent).toContain('alpha-agent');

    const refreshBtn = container!.querySelector('header button') as HTMLButtonElement;
    await act(async () => {
      refreshBtn.click();
    });

    await act(async () => {
      root!.render(
        <ProjectLiveFleet
          http={(async (path: string) => (path === '/api/sessions' ? gateB.promise : {})) as never}
          projectRoot="C:/proj-b"
          carrierId="carrier-b"
          nativeSessions={[]}
        />,
      );
    });
    expect(container!.textContent).not.toContain('alpha-agent');

    await act(async () => {
      gateARefresh.reject(new Error('OLD_PROJECT_FLEET_ERROR'));
    });
    expect(container!.textContent).not.toContain('OLD_PROJECT_FLEET_ERROR');

    await act(async () => {
      gateB.resolve([makeSession('s-b', 'C:/proj-b', 'charlie-agent')]);
    });
    await act(async () => {});
    expect(container!.textContent).toContain('charlie-agent');

    // Switch to empty carrierId clears previous fleet and resets loading
    await act(async () => {
      root!.render(
        <ProjectLiveFleet
          http={(async () => []) as never}
          projectRoot="C:/proj-b"
          carrierId=""
          nativeSessions={[]}
        />,
      );
    });
    expect(container!.textContent).not.toContain('charlie-agent');
    expect(refreshBtn.disabled).toBe(false);
  });
});
