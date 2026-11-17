/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionProcesses } from '../src/SessionProcesses.js';

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

describe('SessionProcesses session-switch sequence guard', () => {
  it('fetches new session even while old read() is pending and ignores stale results', async () => {
    const gateA = deferred<Record<string, unknown>>();

    const command = async (_type: string, payload?: Record<string, unknown>) => {
      const sid = String(payload?.sessionId ?? '');
      if (sid === 'sess-A') return gateA.promise;
      return {
        sessionId: sid,
        processes: [
          {
            sessionId: sid,
            pid: 2222,
            command: 'node B-worker.js',
            tool: 'bash',
            status: 'running',
            startedAt: Date.now(),
          },
        ],
      };
    };

    await act(async () => {
      root!.render(
        <SessionProcesses
          sessionId="sess-A"
          connected={true}
          command={command as never}
          onBack={() => {}}
        />,
      );
    });

    await act(async () => {
      root!.render(
        <SessionProcesses
          sessionId="sess-B"
          connected={true}
          command={command as never}
          onBack={() => {}}
        />,
      );
    });
    expect(container!.textContent).toContain('B-worker');

    await act(async () => {
      gateA.resolve({
        sessionId: 'sess-A',
        processes: [
          {
            sessionId: 'sess-A',
            pid: 1111,
            command: 'node STALE_A.js',
            tool: 'bash',
            status: 'running',
            startedAt: Date.now(),
          },
        ],
      });
    });

    expect(container!.textContent).toContain('B-worker');
    expect(container!.textContent).not.toContain('STALE_A');
  });
});
