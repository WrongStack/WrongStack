/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionMcpTasks } from '../src/SessionMcpTasks.js';

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

describe('SessionMcpTasks session switch reading guard', () => {
  it('immediately fetches mcp.tasks.list for new sessionId and ignores late old session failure', async () => {
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
      return Promise.resolve({ sessionId: 'sess-2', tasks: [] });
    });

    await act(async () => {
      root!.render(
        <SessionMcpTasks connected={true} sessionId="sess-1" command={command as never} />,
      );
    });

    await act(async () => {
      root!.render(
        <SessionMcpTasks connected={true} sessionId="sess-2" command={command as never} />,
      );
    });

    await act(async () => {
      rejectS1(new Error('STALE_MCP_ERROR'));
    });

    expect(requestedSessions).toEqual(['sess-1', 'sess-2']);
    expect(container!.textContent).not.toContain('STALE_MCP_ERROR');
  });
});
