/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpRuntime } from '../src/components/acp-runtime.js';

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

describe('AcpRuntime cancel settlement', () => {
  it('settles pending request() promises when cancelled on model switch', async () => {
    const makeState = (model: string) =>
      ({
        id: 'sess-1',
        model,
        prefs: {},
      }) as never;

    const tracked: Array<{ settled: boolean }> = [];
    const OrigPromise = globalThis.Promise;
    class TrackingPromise<T> extends OrigPromise<T> {
      constructor(
        executor: (
          resolve: (value: T | PromiseLike<T>) => void,
          reject: (reason?: unknown) => void,
        ) => void,
      ) {
        const entry = { settled: false };
        super((res, rej) => {
          tracked.push(entry);
          executor(
            (v) => {
              entry.settled = true;
              res(v);
            },
            (e) => {
              entry.settled = true;
              rej(e);
            },
          );
        });
      }
    }

    let requestEntry: { settled: boolean } | undefined;
    const send = () => {
      requestEntry = tracked.at(-1);
      return true;
    };
    const subscribe = () => () => {};

    await act(async () => {
      root!.render(
        <AcpRuntime
          state={makeState('acp-a')}
          disabled={false}
          send={send}
          subscribe={subscribe}
        />,
      );
    });

    globalThis.Promise = TrackingPromise as unknown as typeof Promise;
    try {
      const details = container!.querySelector('details') as HTMLDetailsElement;
      await act(async () => {
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
      });
    } finally {
      globalThis.Promise = OrigPromise;
    }
    expect(requestEntry?.settled).toBe(false);

    await act(async () => {
      root!.render(
        <AcpRuntime
          state={makeState('acp-b')}
          disabled={false}
          send={send}
          subscribe={subscribe}
        />,
      );
    });
    await Promise.resolve();
    expect(requestEntry?.settled).toBe(true);
  });
});
