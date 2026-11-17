/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionSideEffects } from '../src/SessionSideEffects.js';

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

describe('SessionSideEffects sessionId switch pending reset', () => {
  it('loads new session journal side effects even when previous session load is in flight', async () => {
    const sess1Gate = deferred<Record<string, unknown>>();
    let sess2Calls = 0;

    const command = async (type: string, payload?: Record<string, unknown>) => {
      if (type === 'side_effects.list') {
        return { sessionId: payload?.sessionId, entries: [], total: 0, start: 0, end: 0 };
      }
      if (type === 'session.inspect') {
        if (payload?.id === 'sess-1') return sess1Gate.promise;
        if (payload?.id === 'sess-2') {
          sess2Calls++;
          return {
            journalSideEffects: {
              sessionId: 'sess-2',
              entries: [],
              total: 0,
              start: 0,
              end: 0,
            },
          };
        }
      }
      return {};
    };

    await act(async () => {
      root!.render(
        <SessionSideEffects
          sessionId="sess-1"
          connected={true}
          command={command as never}
          onBack={() => {}}
        />,
      );
    });

    const sourceSelect = Array.from(container!.querySelectorAll('select')).find((s) =>
      Array.from(s.options).some((o) => o.value === 'journal'),
    ) as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(sourceSelect),
        'value',
      )?.set;
      setter?.call(sourceSelect, 'journal');
      sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      root!.render(
        <SessionSideEffects
          sessionId="sess-2"
          connected={true}
          command={command as never}
          onBack={() => {}}
        />,
      );
    });
    expect(sess2Calls).toBe(1);

    await act(async () => {
      sess1Gate.reject(new Error('STALE_SESS1_ERR'));
    });
    expect(container!.textContent).not.toContain('STALE_SESS1_ERR');
  });
});
