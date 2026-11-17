/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionBrowser } from '../src/SessionBrowser.js';

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

describe('SessionBrowser stale browser.live.list guard', () => {
  it('ignores stale replies on sessionId switch and running toggle', async () => {
    let resolve1!: (v: unknown) => void;
    let resolve2!: (v: unknown) => void;
    let call = 0;

    const command = async (type: string) => {
      if (type === 'browser.live.list') {
        call += 1;
        if (call === 1) {
          return new Promise((r) => {
            resolve1 = r;
          });
        }
        return new Promise((r) => {
          resolve2 = r;
        });
      }
      return {};
    };

    await act(async () => {
      root!.render(
        <SessionBrowser
          state={{ sessionId: 'sess-1', running: false, results: {} } as never}
          command={command as never}
          send={async () => ({})}
        />,
      );
    });

    await act(async () => {
      root!.render(
        <SessionBrowser
          state={{ sessionId: 'sess-2', running: true, results: {} } as never}
          command={command as never}
          send={async () => ({})}
        />,
      );
    });

    await act(async () => {
      resolve2({ sessions: [{ id: 'tab-2', title: 'FreshTab', url: 'https://new.test' }] });
    });
    await act(async () => {
      resolve1({ sessions: [{ id: 'tab-1', title: 'StaleTab', url: 'https://old.test' }] });
    });

    expect(container!.textContent).toContain('FreshTab');
    expect(container!.textContent).not.toContain('StaleTab');
  });
});
