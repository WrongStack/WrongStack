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
    abortControllers: new Map(),
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
