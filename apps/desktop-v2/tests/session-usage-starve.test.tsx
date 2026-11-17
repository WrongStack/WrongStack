/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionUsage } from '../src/SessionUsage.js';

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

describe('SessionUsage session switch pending guard', () => {
  it('immediately fetches stats.get for new sessionId and ignores late settlement of old session request', async () => {
    let rejectS1!: (err: unknown) => void;
    const requestedSessions: string[] = [];
    const command = vi.fn((_type: string, payload?: { sessionId?: string }) => {
      const sid = payload?.sessionId ?? '';
      requestedSessions.push(sid);
      if (sid === 'sess-1') {
        return new Promise((_res, rej) => {
          rejectS1 = rej;
        });
      }
      return Promise.resolve({ cost: 0, usage: { input: 10, output: 20 } });
    });

    await act(async () => {
      root!.render(<SessionUsage connected={true} sessionId="sess-1" command={command as never} />);
    });

    await act(async () => {
      root!.render(<SessionUsage connected={true} sessionId="sess-2" command={command as never} />);
    });

    await act(async () => {
      rejectS1(new Error('OLD_SESSION_FAILED'));
    });

    expect(requestedSessions).toEqual(['sess-1', 'sess-2']);
    expect(container!.textContent).not.toContain('OLD_SESSION_FAILED');
  });
});
