import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => JSON.stringify({ authToken: 'owner-token' })),
  createConnection: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: { ...actual, existsSync: mocks.existsSync, readFileSync: mocks.readFileSync },
    existsSync: mocks.existsSync,
    readFileSync: mocks.readFileSync,
  };
});
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  return {
    ...actual,
    default: { ...actual, createConnection: mocks.createConnection },
    createConnection: mocks.createConnection,
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: { ...actual, spawn: mocks.spawn },
    spawn: mocks.spawn,
  };
});

import {
  isSageProjectServerAvailable,
  SageProjectServerConnection,
} from '../src/project-server-client.js';
import { SAGE_PROJECT_SERVER_PROTOCOL_VERSION } from '../src/project-server-protocol.js';

class FakeSocket extends EventEmitter {
  destroyed = false;
  readonly setEncoding = vi.fn();
  readonly write = vi.fn();
  readonly destroy = vi.fn((error?: Error) => {
    this.destroyed = true;
    if (error) this.emit('error', error);
  });
}

function hello(overrides: Record<string, unknown> = {}) {
  return {
    type: 'hello',
    protocolVersion: SAGE_PROJECT_SERVER_PROTOCOL_VERSION,
    pid: 4242,
    projectRoot: 'D:/repo',
    storageRoot: 'D:/repo/.wstack/sage',
    endpoint: 'pipe',
    startedAt: '2026-08-09T10:00:00.000Z',
    ...overrides,
  };
}

function send(socket: FakeSocket, message: unknown): void {
  socket.emit('data', `${JSON.stringify(message)}\n`);
}

describe('SageProjectServerConnection', () => {
  let socket: FakeSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    socket = new FakeSocket();
    mocks.createConnection.mockReturnValue(socket);
  });

  it('authenticates from owner metadata and completes request/event round trips', async () => {
    expect(isSageProjectServerAvailable()).toBe(true);
    const connection = new SageProjectServerConnection('D:/repo');
    const states: string[] = [];
    const events: unknown[] = [];
    connection.onStateChange((state) => states.push(state.status));
    connection.onEvent((event, payload, meta) => events.push({ event, payload, meta }));

    const connecting = connection.connect();
    send(socket, hello());
    await connecting;
    expect(connection.getState()).toMatchObject({
      status: 'connected',
      connected: true,
      pid: 4242,
    });

    const result = connection.call(
      'ping',
      {},
      { meta: { clientId: 'client-1', sessionId: 'session-1', traceId: 'trace-1' } },
    );
    await Promise.resolve();
    const outbound = JSON.parse(String(socket.write.mock.calls[0]?.[0]).trim());
    expect(outbound).toMatchObject({
      type: 'request',
      id: 1,
      op: 'ping',
      meta: {
        clientId: 'client-1',
        authToken: 'owner-token',
        sessionId: 'session-1',
        traceId: 'trace-1',
      },
    });
    expect(outbound.meta).not.toHaveProperty('workspaceRoot');

    send(socket, { type: 'event', event: 'memory.changed', payload: { id: 'm1' } });
    expect(events).toEqual([{ event: 'memory.changed', payload: { id: 'm1' }, meta: undefined }]);
    send(socket, { type: 'response', id: 1, ok: true, result: { pid: 4242 } });
    await expect(result).resolves.toEqual({ pid: 4242 });
    expect(states).toContain('connected');

    connection.close();
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(connection.getState().connected).toBe(false);
  });

  it('reports protocol mismatches and malformed server frames as unavailable status', async () => {
    const mismatch = new SageProjectServerConnection('D:/repo');
    const mismatchPromise = mismatch.status();
    send(socket, hello({ protocolVersion: 999 }));
    await expect(mismatchPromise).resolves.toBeNull();
    expect(socket.destroy).toHaveBeenCalledOnce();

    socket = new FakeSocket();
    mocks.createConnection.mockReturnValue(socket);
    const malformed = new SageProjectServerConnection('D:/repo');
    const malformedPromise = malformed.status();
    socket.emit('data', 'not-json\n');
    await expect(malformedPromise).resolves.toBeNull();
  });

  it('cancels an in-flight request when its signal aborts', async () => {
    const connection = new SageProjectServerConnection('D:/repo');
    const connecting = connection.connect();
    send(socket, hello());
    await connecting;

    const controller = new AbortController();
    const pending = connection.call(
      'readAll',
      {},
      {
        signal: controller.signal,
        meta: { clientId: 'client-1' },
      },
    );
    await Promise.resolve();
    controller.abort(new Error('caller stopped'));
    await expect(pending).rejects.toThrow('caller stopped');
    const frames = socket.write.mock.calls.map(([frame]) => JSON.parse(String(frame).trim()));
    expect(frames.at(-1)).toEqual({ type: 'cancel', id: 1 });
    connection.close();
  });

  it('cancels during auth retry backoff instead of waiting for the delay', async () => {
    const connection = new SageProjectServerConnection('D:/repo') as unknown as {
      ensureConnected: ReturnType<typeof vi.fn>;
      request: ReturnType<typeof vi.fn>;
      call: SageProjectServerConnection['call'];
    };
    connection.ensureConnected = vi.fn(async () => undefined);
    const unauthorized = new Error('unauthorized');
    unauthorized.name = 'UnauthorizedSageRequest';
    connection.request = vi.fn().mockRejectedValue(unauthorized);
    const controller = new AbortController();
    const pending = connection.call('ping', {}, {
      signal: controller.signal,
      meta: { clientId: 'client-1' },
    });

    await Promise.resolve();
    controller.abort(new Error('caller stopped during retry'));
    await expect(pending).rejects.toThrow('caller stopped during retry');
    expect(connection.request).toHaveBeenCalledTimes(1);
  });
});
