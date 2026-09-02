// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextBreakdownModal, parseContextDebugPayload } from '../src/context-breakdown-modal.js';
import type { SimpleSocket } from '../src/lib/ws.js';

const roots: Root[] = [];

interface FakeSocket {
  send: ReturnType<typeof vi.fn>;
  onMessage: ReturnType<typeof vi.fn>;
}

function fakeSocket(): { socket: FakeSocket; emit: (type: string, payload?: unknown) => void } {
  let handler: ((msg: { type: string; payload?: unknown }) => void) | undefined;
  const socket: FakeSocket = {
    send: vi.fn(),
    onMessage: vi.fn((fn: (msg: { type: string; payload?: unknown }) => void) => {
      handler = fn;
      return () => {
        handler = undefined;
      };
    }),
  };
  return {
    socket,
    emit: (type, payload) => handler?.({ type, payload }),
  };
}

function renderModal(
  options: {
    open?: boolean;
    sessionId?: string | null;
    sessionStart?: number | null;
    running?: boolean;
    socket?: FakeSocket;
    contextTokens?: number;
    contextMaxContext?: number;
  } = {},
) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onClose = vi.fn();
  const onCompact = vi.fn();
  const socket = options.socket ?? fakeSocket().socket;
  const socketRef = { current: socket as unknown as SimpleSocket };
  act(() =>
    root.render(
      <ContextBreakdownModal
        open={options.open ?? true}
        onClose={onClose}
        socketRef={socketRef}
        context={{
          load: 0.5,
          tokens: options.contextTokens ?? 5000,
          maxContext: options.contextMaxContext ?? 10000,
          cache: null,
        }}
        sessionId={options.sessionId === undefined ? 'sess-1' : options.sessionId}
        sessionStart={options.sessionStart === undefined ? null : options.sessionStart}
        running={options.running ?? false}
        onCompact={onCompact}
      />,
    ),
  );
  return { host, onClose, onCompact, socket };
}

function key(target: Element, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const breakdownPayload = {
  total: 9000,
  mode: 'balanced',
  policy: { warn: 0.45 },
  systemPrompt: 3000,
  tools: {
    total: 2000,
    count: 2,
    breakdown: [
      { name: 'bash', tokens: 1500 },
      { name: 'read', tokens: 500 },
    ],
  },
  messages: {
    total: 4000,
    count: 3,
    breakdown: [
      { index: 0, role: 'system', tokens: 1000, preview: 'You are WrongStack' },
      { index: 1, role: 'user', tokens: 2000, preview: 'Hello there' },
      { index: 2, role: 'assistant', tokens: 1000, preview: 'Hi' },
    ],
  },
};

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('parseContextDebugPayload', () => {
  it('returns null for non-object payloads', () => {
    expect(parseContextDebugPayload(null)).toBeNull();
    expect(parseContextDebugPayload('nope')).toBeNull();
    expect(parseContextDebugPayload(42)).toBeNull();
  });
  it('returns null when tools/messages sections are missing', () => {
    expect(parseContextDebugPayload({ total: 1 })).toBeNull();
  });
  it('parses a valid payload with defensive coercion', () => {
    const parsed = parseContextDebugPayload(breakdownPayload);
    expect(parsed).not.toBeNull();
    expect(parsed?.total).toBe(9000);
    expect(parsed?.mode).toBe('balanced');
    expect(parsed?.tools.breakdown[0]).toEqual({ name: 'bash', tokens: 1500 });
    expect(parsed?.messages.breakdown[1]).toEqual({
      index: 1,
      role: 'user',
      tokens: 2000,
      preview: 'Hello there',
    });
  });
  it('coerces malformed entries instead of crashing', () => {
    const parsed = parseContextDebugPayload({
      total: 'bad',
      systemPrompt: null,
      tools: { total: 'x', count: 2, breakdown: [{ name: 7, tokens: 'nope' }] },
      messages: {
        total: 1,
        count: 1,
        breakdown: [{ index: 'a', role: 3, tokens: [], preview: null }],
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.total).toBe(0);
    expect(parsed?.systemPrompt).toBe(0);
    expect(parsed?.tools.breakdown[0]).toEqual({ name: '7', tokens: 0 });
    expect(parsed?.messages.breakdown[0]).toEqual({ index: 0, role: '3', tokens: 0, preview: '' });
  });
});

describe('ContextBreakdownModal', () => {
  it('renders nothing when closed', () => {
    const { host } = renderModal({ open: false });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('requests context.debug on open with the session id', () => {
    const { socket } = fakeSocket();
    renderModal({ socket });
    expect(socket.send).toHaveBeenCalledWith('context.debug', { sessionId: 'sess-1' });
  });

  it('renders the breakdown sections from the response', async () => {
    const { socket, emit } = fakeSocket();
    const { host } = renderModal({ socket });
    await act(async () => emit('context.debug', breakdownPayload));
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('ALLOCATION');
    expect(dialog?.textContent).toContain('balanced');
    expect(dialog?.textContent).toContain('TOOL BREAKDOWN');
    expect(dialog?.textContent).toContain('bash');
    expect(dialog?.textContent).toContain('MESSAGE BREAKDOWN');
    expect(dialog?.textContent).toContain('user');
    expect(dialog?.textContent).toContain('Hello there');
  });

  it('shows the session uptime in the summary when a start time is provided', async () => {
    const { socket, emit } = fakeSocket();
    const { host } = renderModal({
      socket,
      sessionStart: Date.now() - 60_000,
    });
    await act(async () => emit('context.debug', breakdownPayload));
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('UPTIME');
    // 60_000ms + the sub-second mount delta formats as "1m 0s" — the tick
    // interval cannot interleave before this synchronous assertion.
    expect(dialog?.textContent).toContain('1m 0s');
  });

  it('omits the tool section when no tools are registered', async () => {
    const { socket, emit } = fakeSocket();
    const { host } = renderModal({ socket });
    await act(async () =>
      emit('context.debug', {
        ...breakdownPayload,
        tools: { total: 0, count: 0, breakdown: [] },
      }),
    );
    expect(host.textContent).not.toContain('TOOL BREAKDOWN');
    expect(host.textContent).toContain('MESSAGE BREAKDOWN');
  });

  it('shows an error when the response is malformed', async () => {
    const { socket, emit } = fakeSocket();
    const { host } = renderModal({ socket });
    await act(async () => emit('context.debug', { total: 1 }));
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Unexpected response');
  });

  it('shows an error when the server does not reply within 5s', async () => {
    vi.useFakeTimers();
    const { host } = renderModal({ socket: fakeSocket().socket });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('No response from server');
  });

  it('re-sends context.debug when refresh is clicked', async () => {
    const { socket, emit } = fakeSocket();
    const { host } = renderModal({ socket });
    await act(async () => emit('context.debug', breakdownPayload));
    act(() => click(host.querySelector('button[aria-label="Refresh"]') as Element));
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(socket.send).toHaveBeenLastCalledWith('context.debug', { sessionId: 'sess-1' });
  });

  it('closes on Escape', () => {
    const { host, onClose } = renderModal({ socket: fakeSocket().socket });
    act(() => key(document.body, { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('calls onCompact when the compact button is clicked and closes via parent', () => {
    const { host, onCompact } = renderModal({ socket: fakeSocket().socket });
    const button = host.querySelector('.ctx-breakdown-compact') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    act(() => click(button));
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it('disables the compact button while running', () => {
    const { host } = renderModal({ socket: fakeSocket().socket, running: true });
    const button = host.querySelector('.ctx-breakdown-compact') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
