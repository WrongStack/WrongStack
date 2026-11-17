/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FailedRunContinue } from '../src/FailedRunContinue.js';

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

describe('FailedRunContinue session-switch send guard', () => {
  it('drops stale report() on resolve and reject after sessionId changes, while reporting active session', async () => {
    let settleSend!: (v: string) => void;
    let rejectSend!: (e: unknown) => void;
    let call = 0;
    const send = vi.fn(() => {
      call += 1;
      if (call === 1) {
        return new Promise<string>((r) => {
          settleSend = r;
        });
      }
      if (call === 2) {
        return new Promise<string>((_r, rej) => {
          rejectSend = rej;
        });
      }
      return Promise.resolve('Resumed current');
    });
    const report = vi.fn();

    const makeState = (sessionId: string) =>
      ({
        connected: true,
        hydrating: false,
        running: false,
        sessionId,
        results: {
          'run.result': {
            status: 'failed',
            error: { message: 'rate limit', recoverable: true },
          },
          'prefs.updated': { autonomy: 'manual' },
        },
        messages: [],
      }) as never;

    await act(async () => {
      root!.render(<FailedRunContinue state={makeState('sess-1')} send={send} report={report} />);
    });
    await act(async () => {
      container!.querySelector('button')!.click();
    });

    await act(async () => {
      root!.render(<FailedRunContinue state={makeState('sess-2')} send={send} report={report} />);
    });
    await act(async () => {
      settleSend('Stale resolve');
    });
    expect(report).not.toHaveBeenCalled();

    await act(async () => {
      container!.querySelector('button')!.click();
    });
    await act(async () => {
      root!.render(<FailedRunContinue state={makeState('sess-3')} send={send} report={report} />);
    });
    await act(async () => {
      rejectSend(new Error('Stale reject'));
    });
    expect(report).not.toHaveBeenCalled();

    await act(async () => {
      container!.querySelector('button')!.click();
    });
    expect(report).toHaveBeenCalledWith('Resumed current', '');
  });
});
