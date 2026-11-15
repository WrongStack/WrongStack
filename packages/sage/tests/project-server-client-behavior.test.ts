import { EventEmitter } from 'node:events';
import { WRONGSTACK_RUNTIME_VERSION } from '@wrongstack/primitives';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => JSON.stringify({ authToken: 'owner-token' })),
  createConnection: vi.fn(),
  spawn: vi.fn(),
  openDaemonLogFd: vi.fn((): number | null => null),
  closeDaemonLogFd: vi.fn(),
}));

vi.mock('../src/daemon-log.js', () => ({
  closeDaemonLogFd: mocks.closeDaemonLogFd,
  openDaemonLogFd: mocks.openDaemonLogFd,
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
  SageProjectServerNotRunningError,
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
    mocks.openDaemonLogFd.mockReturnValue(null);
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

  it('asks a daemon of an older release to stop and connects to its replacement', async () => {
    vi.useFakeTimers();
    // The advertised PID belongs to the socket fixture, not to the runner's OS.
    // Its graceful shutdown has completed before the replacement is spawned.
    const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect([pid, signal]).toEqual([4242, 0]);
      throw Object.assign(new Error('fixture daemon exited'), { code: 'ESRCH' });
    });
    const older = socket;
    const current = new FakeSocket();
    mocks.createConnection.mockReturnValueOnce(older).mockReturnValue(current);
    const connection = new SageProjectServerConnection('D:/repo');
    try {
      const connected = expect(connection.connect()).resolves.toBeUndefined();
      send(older, hello({ runtimeVersion: '1.0.0' }));
      const shutdown = JSON.parse(String(older.write.mock.calls[0]?.[0]).trim());
      expect(shutdown).toMatchObject({
        type: 'shutdown',
        reason: 'older-release-replacement',
        authToken: 'owner-token',
      });
      // Drive the exit probe (50 ms) and election backoff (75 ms) explicitly.
      await vi.advanceTimersByTimeAsync(125);
      expect(probe).toHaveBeenCalledOnce();
      expect(mocks.createConnection).toHaveBeenCalledTimes(2);
      send(current, hello({ runtimeVersion: WRONGSTACK_RUNTIME_VERSION, pid: 5151 }));
      await connected;
      expect(connection.getState()).toMatchObject({ status: 'connected', pid: 5151 });
    } finally {
      connection.close();
      probe.mockRestore();
      vi.useRealTimers();
    }
  });

  it('reuses a daemon of the same release', async () => {
    const connection = new SageProjectServerConnection('D:/repo');
    const connecting = connection.connect();
    send(socket, hello({ runtimeVersion: WRONGSTACK_RUNTIME_VERSION }));
    await connecting;
    expect(socket.write).not.toHaveBeenCalled();
    expect(mocks.createConnection).toHaveBeenCalledOnce();
    connection.close();
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
    const pending = connection.call(
      'ping',
      {},
      {
        signal: controller.signal,
        meta: { clientId: 'client-1' },
      },
    );

    await Promise.resolve();
    controller.abort(new Error('caller stopped during retry'));
    await expect(pending).rejects.toThrow('caller stopped during retry');
    expect(connection.request).toHaveBeenCalledTimes(1);
  });

  it('retries request on UnauthorizedSageRequest after delay completes', async () => {
    vi.useFakeTimers();
    try {
      const connection = new SageProjectServerConnection('D:/repo') as any;
      connection.ensureConnected = vi.fn(async () => undefined);
      const unauthorized = new Error('unauthorized');
      unauthorized.name = 'UnauthorizedSageRequest';
      connection.request = vi
        .fn()
        .mockRejectedValueOnce(unauthorized)
        .mockResolvedValueOnce({ ok: true });

      const reqPromise = connection.call('ping', {}, { meta: { clientId: 'c1' } });
      await vi.advanceTimersByTimeAsync(300);
      await expect(reqPromise).resolves.toEqual({ ok: true });
      expect(connection.request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Connect, send one call, refuse it; returns before call() resumes. */
  async function refuseOneCall() {
    const connection = new SageProjectServerConnection('D:/repo');
    const connecting = connection.connect();
    send(socket, hello());
    await connecting;
    const call = connection.call('ping', {}, { meta: { clientId: 'client-1' } });
    const outcome: { settled: 'pending' | 'resolved' | 'rejected'; reason?: unknown } = {
      settled: 'pending',
    };
    call.then(
      () => {
        outcome.settled = 'resolved';
      },
      (reason) => {
        outcome.settled = 'rejected';
        outcome.reason = reason;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    const first = JSON.parse(String(socket.write.mock.calls.at(-1)?.[0]).trim());
    send(socket, {
      type: 'response',
      id: first.id,
      ok: false,
      error: 'Unauthorized',
      errorName: 'UnauthorizedSageRequest',
    });
    return { connection, outcome };
  }

  it('close() wakes a call sleeping between auth retries instead of leaving it for the delay', async () => {
    vi.useFakeTimers();
    try {
      const { connection, outcome } = await refuseOneCall();
      await vi.advanceTimersByTimeAsync(0); // call() is now inside the retry delay
      expect(outcome.settled).toBe('pending');
      const writes = socket.write.mock.calls.length;

      connection.close();
      await vi.advanceTimersByTimeAsync(0); // no timer time passes

      expect(outcome.settled).toBe('rejected');
      expect((outcome.reason as Error).message).toBe('SAGE server client disconnected');
      await vi.advanceTimersByTimeAsync(200);
      expect(socket.write.mock.calls.length).toBe(writes); // the retry never ran
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() in the same turn as the refusal, before call() resumes, still rejects at once', async () => {
    vi.useFakeTimers();
    try {
      const { connection, outcome } = await refuseOneCall();
      connection.close();
      await vi.advanceTimersByTimeAsync(0);

      expect(outcome.settled).toBe('rejected');
      expect((outcome.reason as Error).message).toBe('SAGE server client disconnected');
      await vi.advanceTimersByTimeAsync(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a call made after close() still waits the full auth-retry delay', async () => {
    vi.useFakeTimers();
    try {
      const connection = new SageProjectServerConnection('D:/repo') as any;
      // releaseConnection() closes and expects the next call to work normally.
      connection.close();
      connection.ensureConnected = vi.fn(async () => undefined);
      const unauthorized = new Error('unauthorized');
      unauthorized.name = 'UnauthorizedSageRequest';
      connection.request = vi
        .fn()
        .mockRejectedValueOnce(unauthorized)
        .mockResolvedValueOnce({ ok: true });

      const reqPromise = connection.call('ping', {}, { meta: { clientId: 'c1' } });
      const settled = expect(reqPromise).resolves.toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(149);
      expect(connection.request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(connection.request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unsubscribes state and event listeners', () => {
    const connection = new SageProjectServerConnection('D:/repo');
    const unsubState = connection.onStateChange(() => {});
    const unsubEvent = connection.onEvent(() => {});
    expect(unsubState).toBeTypeOf('function');
    expect(unsubEvent).toBeTypeOf('function');
    unsubState();
    unsubEvent();
  });

  it('handles shutdown when running and when offline', async () => {
    // 1. When offline / cannot connect
    const offlineConn = new SageProjectServerConnection('D:/repo') as unknown as {
      ensureConnected: ReturnType<typeof vi.fn>;
      shutdown: SageProjectServerConnection['shutdown'];
    };
    offlineConn.ensureConnected = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(offlineConn.shutdown('test')).resolves.toEqual({
      stopped: false,
      reason: 'not-running',
    });

    // 2. When running
    const connection = new SageProjectServerConnection('D:/repo');
    const connecting = connection.connect();
    send(socket, hello({ pid: 12345 }));
    await connecting;

    const shutdownPromise = connection.shutdown('user requested');
    await Promise.resolve();
    const outbound = JSON.parse(String(socket.write.mock.calls.at(-1)?.[0]).trim());
    expect(outbound).toMatchObject({ type: 'shutdown', reason: 'user requested' });

    send(socket, { type: 'response', id: outbound.id, ok: true, result: { stopped: true } });
    await expect(shutdownPromise).resolves.toEqual({
      stopped: true,
      pid: 12345,
    });
  });

  it('handles onClose, rejecting pending requests and transitioning state', async () => {
    const connection = new SageProjectServerConnection('D:/repo');
    const connecting = connection.connect();
    send(socket, hello());
    await connecting;

    const pending = connection.call('ping', {}, { meta: { clientId: 'client-1' } });
    await Promise.resolve();

    // Emitting close triggers onClose
    socket.emit('close');
    await expect(pending).rejects.toThrow('SAGE project server connection closed');
    expect(connection.getState().status).toBe('error');

    // Close on a different socket is ignored
    new FakeSocket();
    socket.emit('close');
  });

  it('names the socket error that closed the connection instead of a bare "connection closed"', async () => {
    const connection = new SageProjectServerConnection('D:/repo');
    const connecting = connection.connect();
    send(socket, hello());
    await connecting;

    const pending = connection.call('listSage', {}, { meta: { clientId: 'client-1' } });
    await Promise.resolve();

    socket.emit('data', 'x'.repeat(8 * 1024 * 1024 + 1));
    expect(socket.destroy).toHaveBeenCalled();
    socket.emit('close');
    await expect(pending).rejects.toThrow(
      /connection closed: SAGE server frame exceeded maximum size/,
    );
  });

  it('handles remote error responses with custom error names and invalidates auth token on refusal', async () => {
    const connection = new SageProjectServerConnection('D:/repo');
    const connecting = connection.connect();
    send(socket, hello());
    await connecting;

    // Custom error name
    const req1 = connection.call('ping', {}, { meta: { clientId: 'client-1' } });
    await Promise.resolve();
    const out1 = JSON.parse(String(socket.write.mock.calls.at(-1)?.[0]).trim());
    send(socket, {
      type: 'response',
      id: out1.id,
      ok: false,
      error: 'Custom failure',
      errorName: 'CustomSageError',
    });
    await expect(req1).rejects.toThrow('Custom failure');

    // UnauthorizedSageRequest error invalidates auth token. Keep the promise:
    // call() treats the refusal as retriable and waits to retry, and the
    // close() below ends that wait. Left as `void`, the rejection went
    // unhandled and failed whichever later test was running when it fired.
    const req2 = connection.call('ping', {}, { meta: { clientId: 'client-1' } });
    // Retried, not surfaced: the refusal itself must not be the rejection.
    const req2Settled = expect(req2).rejects.toThrow('SAGE server client disconnected');
    await Promise.resolve();
    const out2 = JSON.parse(String(socket.write.mock.calls.at(-1)?.[0]).trim());
    send(socket, {
      type: 'response',
      id: out2.id,
      ok: false,
      error: 'Unauthorized',
      errorName: 'UnauthorizedSageRequest',
    });
    // It retries, so we reject all or abort
    connection.close();
    await req2Settled;
  });

  it('handles handshake timeout and request timeout', async () => {
    vi.useFakeTimers();
    try {
      const connection = new SageProjectServerConnection('D:/repo') as any;
      const connectOncePromise = connection.connectOnce();
      const handshakeAssertion = expect(connectOncePromise).rejects.toThrow(
        'SAGE project server handshake timed out',
      );
      await vi.advanceTimersByTimeAsync(6000);
      await handshakeAssertion;

      // Request timeout on an already-connected socket
      socket = new FakeSocket();
      mocks.createConnection.mockReturnValue(socket);
      const conn2 = new SageProjectServerConnection('D:/repo') as any;
      const conn2Connect = conn2.connectOnce();
      send(socket, hello());
      await conn2Connect;

      const reqPromise = conn2.call(
        'ping',
        {},
        {
          timeoutMs: 1000,
          meta: { clientId: 'c1' },
        },
      );
      const reqAssertion = expect(reqPromise).rejects.toThrow(/exceeded its 1000ms timeout/);
      await vi.advanceTimersByTimeAsync(1500);
      await reqAssertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('spawns detached server with directory option, log fd, and safe error handling', () => {
    const fakeChild = new EventEmitter() as any;
    fakeChild.unref = vi.fn();
    mocks.spawn.mockReturnValue(fakeChild);
    mocks.openDaemonLogFd.mockReturnValue(7);

    const connection = new SageProjectServerConnection('D:/repo', '.wstack/sage') as any;
    connection.spawnDetachedServer();

    expect(mocks.openDaemonLogFd).toHaveBeenCalledWith(
      expect.stringContaining('daemon.log'),
      expect.stringContaining('endpoint='),
    );
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['--project-root', 'D:/repo', '--directory', '.wstack/sage']),
      expect.objectContaining({ detached: true, stdio: ['ignore', 7, 7] }),
    );
    expect(fakeChild.unref).toHaveBeenCalled();

    // The parent's copy of the fd is released as soon as the child is live.
    fakeChild.emit('spawn');
    expect(mocks.closeDaemonLogFd).toHaveBeenCalledWith(7);

    // A spawn-level error is safely observable instead of crashing the process.
    fakeChild.emit('error', new Error('spawn failed'));
  });

  it('falls back to discarded stdio when the daemon log sink is unusable', () => {
    const fakeChild = new EventEmitter() as any;
    fakeChild.unref = vi.fn();
    mocks.spawn.mockReturnValue(fakeChild);

    const connection = new SageProjectServerConnection('D:/repo') as any;
    connection.spawnDetachedServer();

    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['--project-root', 'D:/repo']),
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(fakeChild.unref).toHaveBeenCalled();

    // closeDaemonLogFd is still invoked with null and must tolerate it.
    fakeChild.emit('error', new Error('spawn failed'));
    expect(mocks.closeDaemonLogFd).toHaveBeenCalledWith(null);
  });

  it('attach-only: reports a missing daemon by name and never spawns one', async () => {
    mocks.spawn.mockClear();
    const connection = new SageProjectServerConnection('D:/repo', undefined, {
      spawnIfMissing: false,
    });
    (connection as unknown as { connectOnce: unknown }).connectOnce = vi
      .fn()
      .mockRejectedValue(new Error('connect ENOENT'));

    await expect(connection.connect()).rejects.toBeInstanceOf(SageProjectServerNotRunningError);
    await expect(connection.call('ping', {}, { meta: { clientId: 'c1' } })).rejects.toThrow(
      'No running WrongStack SAGE daemon for D:/repo',
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('attach-only: status() still answers null instead of throwing', async () => {
    const connection = new SageProjectServerConnection('D:/repo', undefined, {
      spawnIfMissing: false,
    });
    (connection as unknown as { connectOnce: unknown }).connectOnce = vi
      .fn()
      .mockRejectedValue(new Error('connect ENOENT'));
    await expect(connection.status()).resolves.toBeNull();
  });
});
