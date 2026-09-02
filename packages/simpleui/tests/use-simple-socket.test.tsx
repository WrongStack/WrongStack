// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock SimpleSocket before importing the hook.
const instances: MockSocket[] = [];

class MockSocket {
  options: {
    onMessage: (message: { type: string; payload?: Record<string, unknown> }) => void;
    onState: (state: string) => void;
  };
  connect = vi.fn(async () => {
    // The real SimpleSocket fires onState('connecting') inside the
    // constructor. We do NOT auto-announce here so tests have deterministic
    // control over state transitions; the lifecycle test explicitly checks
    // the initial 'connecting' state that the hook seeds via useState.
  });
  close = vi.fn();
  send = vi.fn();

  constructor(options: {
    onMessage: (message: { type: string; payload?: Record<string, unknown> }) => void;
    onState: (state: string) => void;
  }) {
    this.options = options;
    instances.push(this);
  }
}

vi.mock('../src/lib/ws.js', () => ({
  SimpleSocket: MockSocket,
}));

import type { SimpleSocket } from '../src/lib/ws.js';
import type { UseSimpleSocketOptions } from '../src/hooks/use-simple-socket.js';
const { useSimpleSocket } = await import('../src/hooks/use-simple-socket.js');

interface Captured {
  current: { connection: string };
}

interface ProbeOptions {
  onMessage?: (message: { type: string; payload?: Record<string, unknown> }) => void;
  sessionIdRef: React.RefObject<string | null>;
  socketRef?: React.RefObject<MockSocket | null>;
  onConnectionChange?: (state: string) => void;
  onDisconnect?: () => void;
}

function renderHookViaRoot(captured: Captured, options: ProbeOptions): Root {
  const socketRef = options.socketRef ?? { current: null };
  function Probe(): null {
    const result = useSimpleSocket({
      onMessage: options.onMessage ?? vi.fn(),
      sessionIdRef: options.sessionIdRef,
      socketRef: socketRef as unknown as React.RefObject<SimpleSocket | null>,
      onConnectionChange: options.onConnectionChange,
      onDisconnect: options.onDisconnect,
    } satisfies UseSimpleSocketOptions);
    captured.current = result;
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<Probe />));
  return root;
}

const roots: Root[] = [];

function lastSocket(): MockSocket {
  return instances.at(-1)!;
}

beforeEach(() => {
  instances.length = 0;
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('useSimpleSocket — lifecycle', () => {
  it('starts in the connecting state and creates a socket on mount', () => {
    const captured: Captured = { current: { connection: 'connecting' } };
    renderHookViaRoot(captured, { sessionIdRef: { current: null } });

    expect(captured.current.connection).toBe('connecting');
    expect(instances).toHaveLength(1);
    expect(lastSocket().connect).toHaveBeenCalledTimes(1);
  });

  it('exposes the socket to the consumer via the provided socketRef', () => {
    const socketRef = { current: null as MockSocket | null };
    renderHookViaRoot({ current: { connection: 'connecting' } } as Captured, {
      sessionIdRef: { current: null },
      socketRef,
    });

    expect(socketRef.current).toBe(lastSocket());
  });
});

describe('useSimpleSocket — bootstrap frames on open', () => {
  it('sends the standard four bootstrap frames when the socket opens', () => {
    renderHookViaRoot({ current: { connection: 'connecting' } } as Captured, {
      sessionIdRef: { current: null },
    });
    const socket = lastSocket();

    act(() => socket.options.onState('open'));

    const calls = socket.send.mock.calls.map(([type]) => type);
    expect(calls).toEqual(['providers.saved', 'providers.list', 'prefs.get', 'modes.list']);
  });

  it('also sends sessions.list when a session id is known at open time', () => {
    renderHookViaRoot({ current: { connection: 'connecting' } } as Captured, {
      sessionIdRef: { current: 'sess-1' },
    });
    const socket = lastSocket();

    act(() => socket.options.onState('open'));

    const calls = socket.send.mock.calls.map(([type]) => type);
    expect(calls).toEqual([
      'providers.saved',
      'providers.list',
      'prefs.get',
      'modes.list',
      'sessions.list',
    ]);
    expect(socket.send).toHaveBeenCalledWith('sessions.list', { sessionId: 'sess-1', limit: 12 });
  });

  it('does not send sessions.list when sessionIdRef.current is null', () => {
    renderHookViaRoot({ current: { connection: 'connecting' } } as Captured, {
      sessionIdRef: { current: null },
    });
    act(() => lastSocket().options.onState('open'));

    expect(lastSocket().send).not.toHaveBeenCalledWith('sessions.list', expect.anything());
  });
});

describe('useSimpleSocket — connection state + disconnect', () => {
  it('updates connection state and fires onConnectionChange on every transition', () => {
    const onConnectionChange = vi.fn();
    const captured: Captured = { current: { connection: 'connecting' } };
    renderHookViaRoot(captured, {
      sessionIdRef: { current: null },
      onConnectionChange,
    });

    act(() => lastSocket().options.onState('open'));
    expect(captured.current.connection).toBe('open');
    expect(onConnectionChange).toHaveBeenCalledWith('open');

    act(() => lastSocket().options.onState('closed'));
    expect(captured.current.connection).toBe('closed');
    expect(onConnectionChange).toHaveBeenCalledWith('closed');
  });

  it('fires onDisconnect on every non-open state (connecting + closed)', () => {
    const onDisconnect = vi.fn();
    renderHookViaRoot({ current: { connection: 'connecting' } } as Captured, {
      sessionIdRef: { current: null },
      onDisconnect,
    });

    act(() => lastSocket().options.onState('open'));
    expect(onDisconnect).not.toHaveBeenCalled();

    act(() => lastSocket().options.onState('connecting'));
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    act(() => lastSocket().options.onState('closed'));
    expect(onDisconnect).toHaveBeenCalledTimes(2);
  });
});

describe('useSimpleSocket — message routing', () => {
  it('forwards incoming messages to onMessage', () => {
    const onMessage = vi.fn();
    renderHookViaRoot({ current: { connection: 'connecting' } } as Captured, {
      onMessage,
      sessionIdRef: { current: null },
    });

    const message = { type: 'provider.text_delta', payload: { text: 'hi' } };
    act(() => lastSocket().options.onMessage(message));

    expect(onMessage).toHaveBeenCalledWith(message);
  });
});

describe('useSimpleSocket — cleanup', () => {
  it('clears socketRef.current to null and calls close() on unmount', () => {
    const socketRef = { current: null as MockSocket | null };
    const root = renderHookViaRoot({ current: { connection: 'connecting' } } as Captured, {
      sessionIdRef: { current: null },
      socketRef,
    });
    const socket = lastSocket();
    expect(socketRef.current).toBe(socket);

    act(() => root.unmount());

    expect(socketRef.current).toBeNull();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('recreates the socket when onMessage identity changes', () => {
    const root = renderHookViaRoot({ current: { connection: 'connecting' } } as Captured, {
      onMessage: vi.fn(),
      sessionIdRef: { current: null },
    });
    expect(instances).toHaveLength(1);
    const first = lastSocket();

    // Re-render with a new onMessage identity.
    function Probe2(): null {
      useSimpleSocket({
        onMessage: vi.fn(),
        sessionIdRef: { current: null },
        socketRef: { current: null } as unknown as React.RefObject<SimpleSocket | null>,
      } satisfies UseSimpleSocketOptions);
      return null;
    }
    act(() => root.render(<Probe2 />));

    expect(instances.length).toBeGreaterThanOrEqual(2);
    expect(first.close).toHaveBeenCalled();
  });

  it('does NOT recreate the socket across consumer re-renders when onMessage is stable', () => {
    // SimpleUiSession wraps its mailbox/message-handler bridge in useCallback;
    // this pins the contract that ordinary state-driven re-renders must not
    // close and recreate the socket unless that stable handler identity changes.
    const onMessage = vi.fn();
    const sessionIdRef = { current: null };
    const socketRef = { current: null as MockSocket | null };
    function Probe(props: { renderMarker: number }) {
      void props.renderMarker;
      useSimpleSocket({
        onMessage,
        sessionIdRef,
        socketRef: socketRef as unknown as React.RefObject<SimpleSocket | null>,
      } satisfies UseSimpleSocketOptions);
      return null;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<Probe renderMarker={1} />));
    expect(instances).toHaveLength(1);
    const first = lastSocket();

    act(() => root.render(<Probe renderMarker={2} />));

    expect(instances).toHaveLength(1);
    expect(socketRef.current).toBe(first);
    expect(first.close).not.toHaveBeenCalled();
  });

  it('does NOT recreate the socket when onDisconnect/onConnectionChange identity changes', () => {
    // Call sites pass these as inline arrows (new identity every render).
    // If they re-entered the effect deps, every consumer render would tear
    // the socket down and reconnect — a self-sustaining drop/reconnect loop.
    const onMessage = vi.fn();
    const sessionIdRef = { current: null };
    const socketRef = { current: null as MockSocket | null };
    // Single component type re-rendered with fresh callback props — a
    // different component type would remount and recreate regardless of deps.
    function Probe(props: { onDisconnect: () => void; onConnectionChange: (s: string) => void }) {
      useSimpleSocket({
        onMessage,
        sessionIdRef,
        socketRef: socketRef as unknown as React.RefObject<SimpleSocket | null>,
        onDisconnect: props.onDisconnect,
        onConnectionChange: props.onConnectionChange,
      } satisfies UseSimpleSocketOptions);
      return null;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<Probe onDisconnect={() => {}} onConnectionChange={() => {}} />));
    expect(instances).toHaveLength(1);
    const first = lastSocket();

    // Re-render with the SAME onMessage but fresh inline callbacks, and
    // verify the latest callbacks are still the ones invoked.
    const lateDisconnect = vi.fn();
    const lateConnectionChange = vi.fn();
    act(() =>
      root.render(
        <Probe onDisconnect={lateDisconnect} onConnectionChange={lateConnectionChange} />,
      ),
    );

    expect(instances).toHaveLength(1);
    expect(first.close).not.toHaveBeenCalled();

    act(() => first.options.onState('closed'));
    expect(lateDisconnect).toHaveBeenCalledTimes(1);
    expect(lateConnectionChange).toHaveBeenCalledWith('closed');
  });
});
