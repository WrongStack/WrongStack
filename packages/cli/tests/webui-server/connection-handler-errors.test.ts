import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  type ConnectionHandlerDeps,
  createConnectionHandler,
} from '../../src/webui-server/connection-handler.js';

class TestSocket {
  readonly listeners = new Map<string, (...args: unknown[]) => unknown>();
  readonly close = vi.fn();

  on(event: string, listener: (...args: never[]) => unknown): this {
    this.listeners.set(event, listener as (...args: unknown[]) => unknown);
    return this;
  }

  async receive(data: string): Promise<void> {
    await this.listeners.get('message')?.(Buffer.from(data));
  }
}

function createDeps(handleMessage: ConnectionHandlerDeps['handleMessage']): ConnectionHandlerDeps {
  const clientHandler = { addClient: vi.fn(), removeClient: vi.fn() };
  return {
    host: '127.0.0.1',
    wsToken: '',
    requireToken: false,
    publicHostnames: [],
    publicWsUrl: undefined,
    clients: new Map(),
    currentSessionId: () => 'session-1',
    goalHandler: clientHandler as never,
    specsHandler: clientHandler as never,
    sddBoardHandler: clientHandler as never,
    sddWizardHandler: clientHandler as never,
    worktreeHandler: clientHandler as never,
    terminalHandler: clientHandler as never,
    rateLimitMax: 0,
    send: vi.fn(),
    sessionPayload: (payload) => ({ ...payload, sessionId: 'session-1' }),
    handleMessage,
    pendingConfirms: new Map(),
    buildSessionStartPayload: async () => ({}),
    needsSetup: false,
  };
}

const request = {
  headers: { host: '127.0.0.1', origin: 'http://127.0.0.1' },
  url: '/',
  socket: { remoteAddress: '127.0.0.1' },
} as IncomingMessage;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CLI WebUI connection-handler errors', () => {
  it('labels invalid JSON as a parse failure without dispatching it', async () => {
    const handleMessage = vi.fn();
    const socket = new TestSocket();
    // Invalid JSON is a wire-level fault, not a server fault — see the
    // severity policy in connection-lifecycle.ts. Benign client drift logs
    // at warn, not error.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await createConnectionHandler(createDeps(handleMessage))(socket as never as WebSocket, request);

    await socket.receive('{bad json');

    expect(handleMessage).not.toHaveBeenCalled();
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      event: 'webui_server.message_parse_failed',
      level: 'warn',
    });
  });

  it('labels dispatch exceptions as handler failures', async () => {
    const handleMessage = vi.fn().mockRejectedValue(new Error('handler exploded'));
    const socket = new TestSocket();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await createConnectionHandler(createDeps(handleMessage))(socket as never as WebSocket, request);

    await socket.receive('{"type":"kanban.get"}');

    expect(handleMessage).toHaveBeenCalledOnce();
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      event: 'webui_server.message_handler_failed',
      message: 'handler exploded',
    });
  });
});

/**
 * A closed SOCKET is not a stopped run.
 *
 * The handler used to delete the acting tab's entry from the run-lock registry
 * on `close` — without aborting anything. The run kept going while
 * `isRunActive` answered `false`, so `session.delete` could unlink the journal
 * a live run was still appending to, and the next `user_message` claimed a
 * second lock for the same session and hit "Agent.run() is already in
 * progress". Background runs are meant to outlive their tab; the run's own
 * `finally` is what releases the lock.
 *
 * Enforced structurally rather than by assertion: the handler is not given the
 * registry at all, so it cannot touch it. The type-level check below stops the
 * dependency from being quietly reintroduced.
 */
describe('CLI WebUI connection-handler — socket close and run locks', () => {
  it('has no access to the run-lock registry', () => {
    type HasAbortRegistry = 'abortControllers' extends keyof ConnectionHandlerDeps ? true : false;
    const hasAbortRegistry: HasAbortRegistry = false;
    expect(hasAbortRegistry).toBe(false);
  });

  it('drops the client on close without failing', async () => {
    const deps = createDeps(async () => undefined);
    const handler = createConnectionHandler(deps);
    const socket = new TestSocket();
    handler(socket as never as WebSocket, request);
    await Promise.resolve();
    expect(deps.clients.size).toBe(1);

    await socket.listeners.get('close')?.();
    expect(deps.clients.size).toBe(0);
  });
});
