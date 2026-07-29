import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  type ClientWithConnectionInfo,
  createConnectionLifecycle,
} from '../src/server/connection-lifecycle.js';

class TestSocket {
  readonly listeners = new Map<string, (...args: unknown[]) => unknown>();
  on(event: string, listener: (...args: never[]) => unknown): this {
    this.listeners.set(event, listener as (...args: unknown[]) => unknown);
    return this;
  }
  async emit(event: string, value?: unknown): Promise<void> {
    await this.listeners.get(event)?.(value);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createConnectionLifecycle', () => {
  it('installs socket error protection before authentication and does not register a denial', async () => {
    const socket = new TestSocket();
    const clients = new Map<WebSocket, { id: string }>();
    const registerClient = vi.fn();
    const lifecycle = createConnectionLifecycle({
      clients,
      pendingConfirms: new Map(),
      authenticate: (ws) => {
        expect(ws).toBe(socket);
        expect(socket.listeners.has('error')).toBe(true);
        return false;
      },
      createClient: (_ws, id) => ({ id }),
      registerClient,
      decode: () => ({ ok: false, issue: { code: 'bad', message: 'bad' } }),
      dispatch: vi.fn(),
      send: vi.fn(),
      sessionPayload: (payload) => payload,
      buildInitialPayload: vi.fn(async () => ({})),
    });

    await lifecycle(socket as never, undefined);
    expect(registerClient).not.toHaveBeenCalled();
    expect(clients.size).toBe(0);
  });

  it('replays pending confirms, sends session.start, and dispatches decoded messages', async () => {
    const socket = new TestSocket();
    const send = vi.fn();
    const dispatch = vi.fn(async () => undefined);
    const lifecycle = createConnectionLifecycle({
      clients: new Map<WebSocket, { id: string }>(),
      pendingConfirms: new Map([['confirm-1', { resolve: vi.fn(), payload: { id: 'confirm-1' } }]]),
      createClient: (_ws, id) => ({ id }),
      registerClient: vi.fn(),
      decode: () => ({ ok: true, message: { type: 'ping' } }),
      dispatch,
      send,
      sessionPayload: (payload) => payload,
      buildInitialPayload: async () => ({ sessionId: 'session-1' }),
    });

    await lifecycle(socket as never, undefined);
    await socket.emit('message', Buffer.from('{"type":"ping"}'));
    expect(send).toHaveBeenCalledWith(socket, {
      type: 'tool.confirm_needed',
      payload: { id: 'confirm-1' },
    });
    expect(send).toHaveBeenCalledWith(socket, {
      type: 'session.start',
      payload: { sessionId: 'session-1' },
    });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('drains pending confirmations after the final client disconnects', async () => {
    vi.useFakeTimers();
    const socket = new TestSocket();
    const resolve = vi.fn();
    const lifecycle = createConnectionLifecycle({
      clients: new Map<WebSocket, { id: string }>(),
      pendingConfirms: new Map([['confirm-1', { resolve }]]),
      createClient: (_ws, id) => ({ id }),
      registerClient: vi.fn(),
      decode: () => ({ ok: true, message: {} }),
      dispatch: vi.fn(async () => undefined),
      send: vi.fn(),
      sessionPayload: (payload) => payload,
      buildInitialPayload: async () => ({}),
      confirmDrainGraceMs: 10,
    });

    await lifecycle(socket as never, undefined);
    await socket.emit('close');
    await vi.advanceTimersByTimeAsync(10);
    expect(resolve).toHaveBeenCalledWith('no');
  });
});

describe('createConnectionLifecycle verbose rejection logging', () => {
  it('falls back to the standard log shape when verboseWsLogging is false', async () => {
    const socket = new TestSocket();
    const log = vi.fn();
    const lifecycle = createConnectionLifecycle<
      ClientWithConnectionInfo,
      undefined,
      { type: string }
    >({
      clients: new Map<WebSocket, ClientWithConnectionInfo>(),
      pendingConfirms: new Map(),
      verboseWsLogging: false,
      log,
      createClient: (_ws, connId) => ({ connId, sessionId: 's1' }),
      registerClient: vi.fn(),
      decode: () => ({
        ok: false,
        issue: { code: 'unknown_type', message: 'Unknown client message: bogus' },
      }),
      dispatch: vi.fn(async () => undefined),
      send: vi.fn(),
      sessionPayload: (payload) => payload,
      buildInitialPayload: async () => ({}),
    });

    await lifecycle(socket as never, undefined);
    await socket.emit('message', Buffer.from('{}'));
    // `unknown_type` is a benign client-drift signal (stale bundle, deprecated
    // type, extra payload) — see the severity policy comment in
    // `connection-lifecycle.ts`. The hook delivers `warn`, not `error`.
    expect(log).toHaveBeenCalledWith(
      'warn',
      'webui_server.message_rejected',
      'Unknown client message: bogus',
    );
  });

  it('emits enriched JSON with per-connection identity when verboseWsLogging is true', async () => {
    const socket = new TestSocket();
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lifecycle = createConnectionLifecycle<
      ClientWithConnectionInfo,
      undefined,
      { type: string }
    >({
      clients: new Map<WebSocket, ClientWithConnectionInfo>(),
      pendingConfirms: new Map(),
      verboseWsLogging: true,
      clientContext: {
        agentId: 'leader',
        projectRoot: '/tmp/proj',
      },
      // `remoteAddress` is per-connection identity, so it rides on the client
      // object (read by `logRejection`) rather than on `clientContext` — see
      // the `clientContext` doc comment in connection-lifecycle.ts.
      createClient: (_ws, connId) => ({
        connId,
        sessionId: 'sess-42',
        remoteAddress: '127.0.0.1',
      }),
      registerClient: vi.fn(),
      decode: () => ({
        ok: false,
        issue: { code: 'unknown_type', message: 'Unknown client message: bogus' },
      }),
      dispatch: vi.fn(async () => undefined),
      send: vi.fn(),
      sessionPayload: (payload) => payload,
      buildInitialPayload: async () => ({}),
    });

    await lifecycle(socket as never, undefined);
    await socket.emit('message', Buffer.from('{}'));

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const line = consoleSpy.mock.calls[0]?.[0];
    expect(typeof line).toBe('string');
    const parsed = JSON.parse(String(line));
    // `unknown_type` is a benign client-drift signal — see severity policy in
    // `connection-lifecycle.ts`. The verbose payload carries `level: 'warn'`
    // so log consumers can filter on `level` rather than `code` if they
    // prefer.
    expect(parsed).toMatchObject({
      level: 'warn',
      event: 'webui_server.message_rejected',
      message: 'Unknown client message: bogus',
      connectionId: 'c1',
      sessionId: 'sess-42',
      agentId: 'leader',
      projectRoot: '/tmp/proj',
      remoteAddress: '127.0.0.1',
      code: 'unknown_type',
      type: 'bogus',
    });
    expect(parsed).toHaveProperty('timestamp');
  });

  it('extracts the rejected message type from the issue message when code is unknown_type', async () => {
    const socket = new TestSocket();
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lifecycle = createConnectionLifecycle<
      ClientWithConnectionInfo,
      undefined,
      { type: string }
    >({
      clients: new Map<WebSocket, ClientWithConnectionInfo>(),
      pendingConfirms: new Map(),
      verboseWsLogging: true,
      createClient: (_ws, connId) => ({ connId, sessionId: 's1' }),
      registerClient: vi.fn(),
      decode: () => ({
        ok: false,
        issue: { code: 'unknown_type', message: 'Unknown server message: action.run' },
      }),
      dispatch: vi.fn(async () => undefined),
      send: vi.fn(),
      sessionPayload: (payload) => payload,
      buildInitialPayload: async () => ({}),
    });

    await lifecycle(socket as never, undefined);
    await socket.emit('message', Buffer.from('{}'));

    const line = consoleSpy.mock.calls[0]?.[0];
    expect(typeof line).toBe('string');
    const parsed = JSON.parse(String(line));
    expect(parsed['type']).toBe('action.run');
    // unknown_type is warn, not error — see severity policy.
    expect(parsed['level']).toBe('warn');
  });

  it('propagates the clientContext fields onto the verbose log payload', async () => {
    const socket = new TestSocket();
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lifecycle = createConnectionLifecycle<
      ClientWithConnectionInfo,
      undefined,
      { type: string }
    >({
      clients: new Map<WebSocket, ClientWithConnectionInfo>(),
      pendingConfirms: new Map(),
      verboseWsLogging: true,
      clientContext: { agentId: 'executor' },
      createClient: (_ws, connId) => ({ connId, sessionId: 's1' }),
      registerClient: vi.fn(),
      decode: () => ({
        ok: false,
        issue: { code: 'invalid_envelope', message: 'Protocol frame is not valid JSON' },
      }),
      dispatch: vi.fn(async () => undefined),
      send: vi.fn(),
      sessionPayload: (payload) => payload,
      buildInitialPayload: async () => ({}),
    });

    await lifecycle(socket as never, undefined);
    await socket.emit('message', Buffer.from('not-json'));

    const line = consoleSpy.mock.calls[0]?.[0];
    const parsed = JSON.parse(String(line));
    // `invalid_envelope` is the canonical decoder code for "frame did not
    // parse" — benign client wire fault, severity warn (see severity policy
    // in `connection-lifecycle.ts`).
    expect(parsed).toMatchObject({
      level: 'warn',
      event: 'webui_server.message_parse_failed',
      agentId: 'executor',
      code: 'invalid_envelope',
    });
    // projectRoot/remoteAddress omitted — not provided in clientContext
    expect(parsed).not.toHaveProperty('projectRoot');
    expect(parsed).not.toHaveProperty('remoteAddress');
    // No unknown_type → no `type` field
    expect(parsed).not.toHaveProperty('type');
  });

  it('omits per-connection identity when client lacks connId/sessionId', async () => {
    const socket = new TestSocket();
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const lifecycle = createConnectionLifecycle<
      ClientWithConnectionInfo,
      undefined,
      { type: string }
    >({
      clients: new Map<WebSocket, ClientWithConnectionInfo>(),
      pendingConfirms: new Map(),
      verboseWsLogging: true,
      createClient: () => ({}),
      registerClient: vi.fn(),
      decode: () => ({
        ok: false,
        issue: { code: 'unknown_type', message: 'Unknown client message: foo' },
      }),
      dispatch: vi.fn(async () => undefined),
      send: vi.fn(),
      sessionPayload: (payload) => payload,
      buildInitialPayload: async () => ({}),
    });

    await lifecycle(socket as never, undefined);
    await socket.emit('message', Buffer.from('{}'));

    const line = consoleSpy.mock.calls[0]?.[0];
    const parsed = JSON.parse(String(line));
    expect(parsed).not.toHaveProperty('connectionId');
    expect(parsed).not.toHaveProperty('sessionId');
    expect(parsed['type']).toBe('foo');
    expect(parsed['level']).toBe('warn');
  });

  it('routes the enriched verbose payload through options.log when both are set', async () => {
    const socket = new TestSocket();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.fn();
    const lifecycle = createConnectionLifecycle<
      ClientWithConnectionInfo,
      undefined,
      { type: string }
    >({
      clients: new Map<WebSocket, ClientWithConnectionInfo>(),
      pendingConfirms: new Map(),
      verboseWsLogging: true,
      clientContext: { agentId: 'leader' },
      log,
      createClient: (_ws, connId) => ({ connId, sessionId: 'sess-77' }),
      registerClient: vi.fn(),
      // `unsafe_key` → error per severity policy (decoder prototype-pollution
      // tripwire). Using an error-level issue here keeps the assertion
      // meaningful: it distinguishes verbose mode's `error` upgrade path
      // from the warn-only path that `unknown_type` / `invalid_envelope`
      // take.
      decode: () => ({
        ok: false,
        issue: { code: 'unsafe_key', message: 'Tripwire fired: __proto__' },
      }),
      dispatch: vi.fn(async () => undefined),
      send: vi.fn(),
      sessionPayload: (payload) => payload,
      buildInitialPayload: async () => ({}),
    });

    await lifecycle(socket as never, undefined);
    await socket.emit('message', Buffer.from('{}'));

    // The consumer-supplied logger must receive the enriched structured
    // payload — this is the whole point of verbose mode — and must NOT
    // silently fall through to console.*.
    expect(log).toHaveBeenCalledWith(
      'error',
      'webui_server.message_rejected',
      expect.objectContaining({
        level: 'error',
        event: 'webui_server.message_rejected',
        message: 'Tripwire fired: __proto__',
        connectionId: 'c1',
        sessionId: 'sess-77',
        agentId: 'leader',
        code: 'unsafe_key',
      }),
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('fires onSecurityRejection for unsafe_key but not for unknown_type', async () => {
    const socket = new TestSocket();
    const onSecurityRejection = vi.fn();
    const lifecycle = createConnectionLifecycle<
      ClientWithConnectionInfo,
      undefined,
      { type: string }
    >({
      clients: new Map<WebSocket, ClientWithConnectionInfo>(),
      pendingConfirms: new Map(),
      verboseWsLogging: true,
      clientContext: { agentId: 'leader', projectRoot: '/p' },
      onSecurityRejection,
      createClient: (_ws, connId) => ({ connId, sessionId: 'sess-1' }),
      registerClient: vi.fn(),
      decode: () => ({
        ok: false,
        issue: { code: 'unsafe_key', message: 'Unsafe protocol key: __proto__' },
      }),
      dispatch: vi.fn(async () => undefined),
      send: vi.fn(),
      sessionPayload: (payload) => payload,
      buildInitialPayload: async () => ({}),
    });
    const log = vi.fn();
    const lifecycle2 = createConnectionLifecycle<
      ClientWithConnectionInfo,
      undefined,
      { type: string }
    >({
      clients: new Map<WebSocket, ClientWithConnectionInfo>(),
      pendingConfirms: new Map(),
      verboseWsLogging: true,
      log,
      onSecurityRejection,
      createClient: (_ws, connId) => ({ connId, sessionId: 'sess-2' }),
      registerClient: vi.fn(),
      decode: () => ({
        ok: false,
        issue: { code: 'unknown_type', message: 'Unknown client message: bogus' },
      }),
      dispatch: vi.fn(async () => undefined),
      send: vi.fn(),
      sessionPayload: (payload) => payload,
      buildInitialPayload: async () => ({}),
    });

    // First connection: unsafe_key rejection → callback fires with details
    await lifecycle(socket as never, undefined);
    await socket.emit('message', Buffer.from('{}'));
    expect(onSecurityRejection).toHaveBeenCalledTimes(1);
    expect(onSecurityRejection).toHaveBeenCalledWith({
      issueCode: 'unsafe_key',
      issueMessage: 'Unsafe protocol key: __proto__',
      eventName: 'webui_server.message_rejected',
      connectionId: 'c1',
      sessionId: 'sess-1',
      agentId: 'leader',
      projectRoot: '/p',
    });

    // Second connection: unknown_type rejection → callback does NOT fire
    await lifecycle2(socket as never, undefined);
    await socket.emit('message', Buffer.from('{}'));
    expect(onSecurityRejection).toHaveBeenCalledTimes(1); // unchanged
  });

  // Severity policy: only `unsafe_key` and `too_deep` trip the error
  // channel — both are the decoder's prototype-pollution and DoS tripwires.
  // Coverage here is intentionally positive (asserts `error`, not warn) so a
  // future refactor cannot silently downgrade these to warn without breaking
  // a test.
  it.each(['unsafe_key', 'too_deep'] as const)(
    'keeps decoder-tripwire code %s at level error regardless of verbose mode',
    async (code) => {
      const socket = new TestSocket();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const lifecycle = createConnectionLifecycle<
        ClientWithConnectionInfo,
        undefined,
        { type: string }
      >({
        clients: new Map<WebSocket, ClientWithConnectionInfo>(),
        pendingConfirms: new Map(),
        verboseWsLogging: true,
        createClient: (_ws, connId) => ({ connId, sessionId: 's1' }),
        registerClient: vi.fn(),
        decode: () => ({
          ok: false,
          issue: { code, message: `Tripwire fired: ${code}` },
        }),
        dispatch: vi.fn(async () => undefined),
        send: vi.fn(),
        sessionPayload: (payload) => payload,
        buildInitialPayload: async () => ({}),
      });

      await lifecycle(socket as never, undefined);
      await socket.emit('message', Buffer.from('{}'));

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(String(consoleSpy.mock.calls[0]?.[0]));
      expect(parsed.level).toBe('error');
      expect(parsed.code).toBe(code);
    },
  );
});
