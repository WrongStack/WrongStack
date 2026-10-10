// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const socketMocks = vi.hoisted(() => ({
  close: vi.fn(),
  connect: vi.fn(),
  send: vi.fn(),
  onMessage: null as ((message: unknown) => void) | null,
}));

vi.mock('../src/lib/ws.js', () => ({
  SimpleSocket: class SimpleSocketMock {
    constructor(
      private readonly options: {
        onState: (state: string) => void;
        onMessage?: (message: unknown) => void;
      },
    ) {
      // Capture whichever ingress the hook wires: the constructor option
      // and/or the first subscription, so tests can emit server frames.
      if (options.onMessage) socketMocks.onMessage = options.onMessage;
    }

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

    onMessage(handler?: (message: unknown) => void): () => void {
      // Capture the LATEST subscription, not the first: a resubscribe
      // (handler identity change) must replace a stale closure.
      if (handler) socketMocks.onMessage = handler;
      return vi.fn();
    }
  },
}));

import { SimpleUiSession } from '../src/simple-ui-session.js';

// jsdom does not implement Element.scrollTo; the sticky-scroll RAF path
// calls it whenever messages change at composition level. Polyfill it so
// characterization runs are not polluted by an unhandled error.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = () => {};
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderSession(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<SimpleUiSession />);
    await Promise.resolve();
  });
}

function emitServerFrame(message: unknown): Promise<void> {
  return act(async () => {
    socketMocks.onMessage?.(message);
    await Promise.resolve();
  });
}

function pressGlobal(keys: KeyboardEventInit): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...keys }),
    );
  });
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
  vi.clearAllMocks();
  socketMocks.onMessage = null;
});

describe('SimpleUiSession composition', () => {
  it('boots the socket contract and renders the leader workspace', async () => {
    await renderSession();

    expect(socketMocks.connect).toHaveBeenCalledOnce();
    expect(socketMocks.send).toHaveBeenCalledWith('providers.saved');
    expect(socketMocks.send).toHaveBeenCalledWith('providers.list');
    expect(socketMocks.send).toHaveBeenCalledWith('prefs.get');
    expect(socketMocks.send).toHaveBeenCalledWith('modes.list');
    expect(container!.textContent).toContain('READY IN');
    expect(container!.querySelector('[aria-label="Message"]')).not.toBeNull();
  });

  it('opens the command palette with Ctrl+K and closes it with Escape', async () => {
    await renderSession();
    expect(container!.querySelector('.command-palette')).toBeNull();

    pressGlobal({ key: 'k', ctrlKey: true });
    const dialog = container!.querySelector('.command-palette[role="dialog"]');
    expect(dialog).not.toBeNull();

    // Escape must close from anywhere inside the dialog, not just the input.
    act(() => {
      dialog!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(container!.querySelector('.command-palette')).toBeNull();
  });

  it('reflects a server session.start frame in the workspace', async () => {
    await renderSession();
    expect(container!.textContent).toContain('READY IN');

    await emitServerFrame({
      type: 'session.start',
      payload: {
        sessionId: 'sess-char',
        provider: 'openai',
        model: 'gpt-4o',
        projectName: 'Characterization Project',
        cwd: '/tmp',
        startedAt: new Date(0).toISOString(),
        reset: true,
        isRunning: false,
      },
    });

    expect(container!.querySelector('.empty-state h1')?.textContent).toBe(
      'Characterization Project',
    );
  });

  it('sends a composed message through the global Ctrl+Enter path', async () => {
    await renderSession();
    await emitServerFrame({
      type: 'session.start',
      payload: {
        sessionId: 'sess-char',
        provider: 'openai',
        model: 'gpt-4o',
        projectName: 'Characterization Project',
        cwd: '/tmp',
        startedAt: new Date(0).toISOString(),
        reset: true,
        isRunning: false,
      },
    });

    const textarea = container!.querySelector<HTMLTextAreaElement>('textarea');
    expect(textarea).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, 'Ship the characterization note');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    pressGlobal({ key: 'Enter', ctrlKey: true });

    // The transcript renders message text through the async markdown
    // pipeline — let pending hooks flush before asserting on the DOM.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const userFrame = socketMocks.send.mock.calls.find((call) => call[0] === 'user_message');
    expect(userFrame).toBeDefined();
    expect(JSON.stringify(userFrame?.[1] ?? null)).toContain('Ship the characterization note');
    expect(container!.querySelector('.empty-state')).toBeNull();
  });
});
