// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const socketMocks = vi.hoisted(() => ({ close: vi.fn(), connect: vi.fn(), send: vi.fn() }));

vi.mock('../src/lib/ws.js', () => ({
  SimpleSocket: class SimpleSocketMock {
    constructor(private readonly options: { onState: (state: string) => void }) {}

    connect(): Promise<void> {
      socketMocks.connect();
      this.options.onState('open');
      return Promise.resolve();
    }

    close(): void {
      socketMocks.close();
    }

    send(...args: unknown[]): void {
      socketMocks.send(...args);
    }

    onMessage(): () => void {
      return vi.fn();
    }
  },
}));

import { SimpleUiSession } from '../src/simple-ui-session.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
  vi.clearAllMocks();
});

describe('SimpleUiSession composition', () => {
  it('boots the socket contract and renders the leader workspace', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<SimpleUiSession />);
      await Promise.resolve();
    });

    expect(socketMocks.connect).toHaveBeenCalledOnce();
    expect(socketMocks.send).toHaveBeenCalledWith('providers.saved');
    expect(socketMocks.send).toHaveBeenCalledWith('providers.list');
    expect(socketMocks.send).toHaveBeenCalledWith('prefs.get');
    expect(socketMocks.send).toHaveBeenCalledWith('modes.list');
    expect(container.textContent).toContain('READY IN');
    expect(container.querySelector('[aria-label="Message"]')).not.toBeNull();
  });
});
