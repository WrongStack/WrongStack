/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HqImportPanel } from '../src/components/hq-import.js';
import type { SessionController } from '../src/lib/use-session.js';

type Frame = { type: string; payload: unknown };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function harness() {
  const listeners = new Set<(frame: Frame) => void>();
  const send = vi.fn((_type: string, _payload?: Record<string, unknown>) => true);
  const controller = {
    send,
    subscribe: (listener: (frame: Frame) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as SessionController;
  const emit = async (payload: unknown) =>
    act(async () => {
      for (const listener of listeners) listener({ type: 'hq.state', payload });
    });
  return { controller, send, emit, listeners };
}

function button(name: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

describe('HqImportPanel', () => {
  it('asks for status, hides on a host without HQ, and drives enroll → import → unenroll', async () => {
    const h = harness();
    await act(async () => root!.render(<HqImportPanel controller={h.controller} />));
    expect(h.send).toHaveBeenCalledWith('hq.status');

    await h.emit({ available: false, enrolled: false });
    expect(container!.textContent).toBe('');

    await h.emit({ available: true, enrolled: false });
    const [url, token] = [...container!.querySelectorAll('input')];
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(url, 'https://hq.example');
      url!.dispatchEvent(new Event('input', { bubbles: true }));
      set.call(token, 'WSHQ-code');
      token!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Connect this machine').click());
    expect(h.send).toHaveBeenLastCalledWith('hq.enroll', {
      hqUrl: 'https://hq.example',
      token: 'WSHQ-code',
    });
    expect(button('Connecting…').disabled).toBe(true);

    await h.emit({
      available: true,
      enrolled: true,
      hqUrl: 'https://hq.example',
      hqFingerprint: 'aa',
      deviceFingerprint: 'bb',
      granted: [{ id: 'team', type: 'openai', family: 'openai-compatible' }, { type: 'nameless' }],
    });
    expect(container!.textContent).toContain('team · openai-compatible');
    expect(container!.textContent).toContain('HQ aa · this machine bb');
    expect(container!.querySelectorAll('li')).toHaveLength(1);
    await act(async () => button('Import all').click());
    expect(h.send).toHaveBeenLastCalledWith('hq.import', {});

    await h.emit({
      available: true,
      enrolled: true,
      hqUrl: 'https://hq.example',
      granted: [{ id: 'team', type: 'openai' }],
      report: ['Added team', 3],
    });
    expect(container!.querySelector('[role="status"]')?.textContent).toBe('Added team');

    await act(async () => button('Disconnect and remove keys').click());
    expect(h.send).toHaveBeenLastCalledWith('hq.unenroll', { removeKeys: true });
    await h.emit({ available: true, enrolled: false, error: 'HQ refused' });
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe('HQ refused');
  });

  it('stops listening on unmount', async () => {
    const h = harness();
    await act(async () => root!.render(<HqImportPanel controller={h.controller} />));
    expect(h.listeners.size).toBe(1);
    await act(async () => root!.unmount());
    root = null;
    expect(h.listeners.size).toBe(0);
  });
});
