import type { WSSessionStart } from '@wrongstack/webui-protocol';
import { WrongStackError } from './errors.js';

/**
 * The part of a WebSocket the client uses. Node 22+ and browsers provide one
 * globally; the `ws` package's class fits too.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: 'open' | 'error', listener: () => void): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

/** A frame as it arrives: `seq`/`stream` ride beside `type` on a session broadcast. */
export type Frame = { type: string; payload?: unknown; seq?: number; stream?: string };

export interface CloseInfo {
  code?: number;
  reason?: string;
}

/** Where a socket's traffic goes once the server has announced the session. */
export interface SocketRoutes {
  frame(frame: Frame): void;
  close(event: CloseInfo): void;
}

export interface OpenedSocket {
  socket: WebSocketLike;
  start: WSSessionStart['payload'];
  /** Frames that arrived before `session.start`, in order. */
  early: Frame[];
}

export const SOCKET_OPEN = 1;

function isSessionStartPayload(value: unknown): value is WSSessionStart['payload'] {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return ['sessionId', 'model', 'provider'].every(
    (key) => typeof payload[key] === 'string' && payload[key].trim().length > 0,
  );
}

/**
 * Open a socket and wait for the server's `session.start`. After that the
 * socket's frames and its close go to `routes`; before it, a failure rejects.
 */
export function openSocket(
  Ctor: WebSocketConstructor,
  options: {
    url: string;
    token?: string | undefined;
    timeoutMs: number;
    onSocket?: ((socket: WebSocketLike) => void) | undefined;
  },
  routes: SocketRoutes,
): Promise<OpenedSocket> {
  return new Promise<OpenedSocket>((resolve, reject) => {
    let socket: WebSocketLike;
    try {
      socket = new Ctor(socketUrl(options.url, options.token));
      options.onSocket?.(socket);
    } catch (error) {
      reject(
        new WrongStackError({ kind: 'connection', code: 'invalid_url', detail: String(error) }),
      );
      return;
    }
    let announced = false;
    let opened = false;
    let settled = false;
    const early: Frame[] = [];
    const timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15_000;
    const timer = setTimeout(() => {
      fail(new WrongStackError({ kind: 'timeout', code: 'connect', retryable: true }));
      socket.close();
    }, timeoutMs);
    const fail = (error: WrongStackError): void => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    // The socket died before `open`. The connect timer measures nothing now:
    // left running it would race the probe and report a refused token or a
    // dead server as a connect timeout. The probe carries its own deadline.
    const failedHandshake = (): void => {
      if (settled || opened) return;
      settled = true;
      clearTimeout(timer);
      void handshakeFailure(options.url, options.token, timeoutMs).then(reject);
    };
    socket.addEventListener('open', () => {
      opened = true;
    });
    socket.addEventListener('error', () => {
      // Node 22's WebSocket fires only `error` for a refused handshake or an
      // unreachable host; `close` never follows. Newer runtimes send both.
      failedHandshake();
    });
    socket.addEventListener('close', (event) => {
      if (announced) {
        routes.close(event);
        return;
      }
      if (settled) return;
      if (opened || event.code === 1000) {
        fail(
          new WrongStackError({
            kind: 'connection',
            code: String(event.code ?? 'closed'),
            detail: event.reason || 'closed before the session was announced',
            retryable: event.code !== 1000,
          }),
        );
        return;
      }
      failedHandshake();
    });
    socket.addEventListener('message', (event) => {
      if (settled) return;
      const frame = parseFrame(event.data);
      if (!frame) return;
      if (announced) {
        routes.frame(frame);
        return;
      }
      if (frame.type !== 'session.start') {
        early.push(frame);
        return;
      }
      if (!isSessionStartPayload(frame.payload)) {
        fail(new WrongStackError({ kind: 'protocol', code: 'invalid_session_start' }));
        socket.close();
        return;
      }
      announced = true;
      clearTimeout(timer);
      resolve({ socket, start: frame.payload, early });
    });
  });
}

/**
 * A socket that closes before `open` cannot tell a refused token from a
 * server that is not there. `/ws-auth` answers 401 to exactly the token the
 * handshake would have refused, so ask it.
 */
async function handshakeFailure(
  url: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<WrongStackError> {
  const parsed = new URL(url);
  const effectiveToken = token || parsed.searchParams.get('token') || undefined;
  parsed.protocol = parsed.protocol.replace(/^ws/i, 'http');
  const probe = new URL('/ws-auth', parsed);
  try {
    const response = await fetch(probe, {
      ...(effectiveToken ? { headers: { 'X-WS-Token': effectiveToken } } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401) {
      return new WrongStackError({
        kind: 'auth',
        code: '401',
        detail: effectiveToken
          ? 'The server refused the access token.'
          : 'The server needs an access token.',
      });
    }
    return new WrongStackError({
      kind: 'connection',
      code: 'handshake_failed',
      detail: `The server answered HTTP ${response.status} but refused the WebSocket.`,
      retryable: true,
    });
  } catch (error) {
    return new WrongStackError({
      kind: 'connection',
      code: 'unreachable',
      detail: `${probe.origin} is not reachable: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    });
  }
}

function socketUrl(url: string, token: string | undefined): string {
  const parsed = new URL(url);
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  if (token) parsed.searchParams.set('token', token);
  return parsed.toString();
}

function parseFrame(data: unknown): Frame | undefined {
  try {
    const text = typeof data === 'string' ? data : String(data);
    const frame = JSON.parse(text) as Frame;
    return frame && typeof frame.type === 'string' ? frame : undefined;
  } catch {
    return undefined;
  }
}
