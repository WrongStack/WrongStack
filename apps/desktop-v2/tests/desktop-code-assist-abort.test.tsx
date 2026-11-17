/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesktopCodeAssist } from '../src/DesktopCodeAssist.js';

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

describe('DesktopCodeAssist abort failure handling', () => {
  it('swallows code.assist.abort rejections on Stop click and restart without unhandledRejection', async () => {
    let runCalls = 0;
    let abortCalls = 0;
    const send = async (type: string) => {
      if (type === 'code.assist.abort') {
        abortCalls += 1;
        throw new Error('ABORT_FAILED');
      }
      if (type === 'code.assist.run') {
        runCalls += 1;
        return new Promise(() => {});
      }
      return {};
    };

    const state = {
      connected: true,
      sessionId: 's1',
      messages: [],
      results: {},
      assists: {},
    } as never;

    await act(async () => {
      root!.render(<DesktopCodeAssist state={state} send={send as never} />);
    });

    const form = container!.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(runCalls).toBe(1);

    const stopBtn = Array.from(container!.querySelectorAll('button')).find((b) =>
      b.textContent?.toLowerCase().includes('stop'),
    );
    expect(stopBtn).toBeDefined();
    await act(async () => {
      stopBtn!.click();
    });

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    await new Promise((r) => setTimeout(r, 15));
    expect(abortCalls).toBeGreaterThanOrEqual(2);
    expect(runCalls).toBe(2);
  });
});
