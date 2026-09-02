// ---------------------------------------------------------------------------
// Fake Telegram Bot API server for deterministic fault-injection tests.
//
// Spawns a local HTTP server that mimics the Telegram Bot API endpoints
// (getMe, getUpdates, sendMessage, sendMessageWithKeyboard,
// answerCallbackQuery).  Each endpoint can be configured with specific
// response behaviours: success payloads, error codes, delays, malformed
// JSON, and crash/restart simulation.
//
// The server is fully controlled by the test — no real network, no token,
// no external dependencies.  Cleanup via close() leaves no process/port.
// ---------------------------------------------------------------------------

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Telegram Bot API envelope shapes. */
interface ApiEnvelope<T> {
  ok: boolean;
  result?: T | undefined;
  description?: string | undefined;
  error_code?: number | undefined;
  parameters?:
    | { retry_after?: number | undefined; migrate_to_chat_id?: number | undefined }
    | undefined;
}

/** Simulated user returned by getMe. */
interface BotUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

/** Simulated message. */
interface Message {
  message_id: number;
  from?: { id: number; is_bot: boolean; first_name: string } | undefined;
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };
  date: number;
  text?: string | undefined;
}

/** Simulated update. */
interface Update {
  update_id: number;
  message?: Message | undefined;
  callback_query?:
    | { id: string; from?: { id: number; is_bot: boolean; first_name: string } | undefined }
    | undefined;
}

// ---------------------------------------------------------------------------
// Handler types
// ---------------------------------------------------------------------------

export type MethodName =
  | 'getMe'
  | 'getUpdates'
  | 'sendMessage'
  | 'sendMessageWithKeyboard'
  | 'answerCallbackQuery';

/** A handler receives the parsed body and can return any response. */
export type EndpointHandler = (
  body: Record<string, unknown>,
) =>
  | { envelope: ApiEnvelope<unknown>; delayMs?: number }
  | { status: number; body: string; delayMs?: number }
  | { malformed: true; body: string; delayMs?: number };

// ---------------------------------------------------------------------------
// Default handlers
// ---------------------------------------------------------------------------

const defaultUser: BotUser = {
  id: 420001,
  is_bot: true,
  first_name: 'TestBot',
  username: 'test_bot',
};

const defaultHandlers: Record<MethodName, EndpointHandler> = {
  getMe: () => ({ envelope: { ok: true, result: defaultUser } }),

  getUpdates: (body) => {
    const offset = Number(body.offset) || 0;
    return {
      envelope: {
        ok: true,
        result: [
          {
            update_id: offset + 1,
            message: {
              message_id: 1,
              chat: { id: 99, type: 'private' },
              date: Math.floor(Date.now() / 1000),
              text: `hello from offset ${offset}`,
            },
          },
        ],
      },
    };
  },

  sendMessage: () => ({
    envelope: {
      ok: true,
      result: {
        message_id: 100 + Math.floor(Math.random() * 900),
        chat: { id: 99, type: 'private' },
        date: Math.floor(Date.now() / 1000),
      },
    },
  }),

  sendMessageWithKeyboard: () => ({
    envelope: {
      ok: true,
      result: {
        message_id: 200,
        chat: { id: 99, type: 'private' },
        date: Math.floor(Date.now() / 1000),
      },
    },
  }),

  answerCallbackQuery: () => ({ envelope: { ok: true, result: true } }),
};

// ---------------------------------------------------------------------------
// Fake server
// ---------------------------------------------------------------------------

export class FakeTelegramServer {
  private server: http.Server;
  private handlers: Record<string, EndpointHandler> = { ...defaultHandlers };
  /** Queue of pending getUpdates responses dispensed on each call. */
  private updateQueue: Update[][] = [];
  /** Call log for assertions. */
  readonly calls: Array<{ method: string; body: Record<string, unknown> }> = [];

  /** Resolves when the server is ready. */
  readonly started: Promise<void>;
  private startResolve!: () => void;

  constructor() {
    this.server = http.createServer((req, res) => this.dispatch(req, res));
    this.started = new Promise((resolve) => {
      this.startResolve = resolve;
    });
  }

  /** Start listening on a random port. Await server.started before using. */
  start(): void {
    this.server.listen(0, '127.0.0.1', () => {
      this.startResolve();
    });
  }

  /** The base URL for this server, e.g. http://127.0.0.1:34567 */
  get baseUrl(): string {
    const addr = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  /** Override a handler for a specific method. */
  on(method: MethodName, handler: EndpointHandler): void {
    this.handlers[method] = handler;
  }

  /** Reset handlers to defaults, clear call log and update queue. */
  reset(): void {
    this.handlers = { ...defaultHandlers };
    this.calls.length = 0;
    this.updateQueue = [];
  }

  /** Queue updates that will be dispensed by the next getUpdates calls. */
  enqueueUpdates(...batches: Update[][]): void {
    this.updateQueue.push(...batches);
  }

  /** Send an error response. */
  static error(
    code: number,
    description: string,
    params?: { retry_after?: number },
  ): ReturnType<EndpointHandler> {
    return {
      envelope: {
        ok: false,
        error_code: code,
        description,
        ...(params ? { parameters: params } : {}),
      },
    };
  }

  /** Send a malformed (non-JSON) response. */
  static malformed(body: string, delayMs = 0): ReturnType<EndpointHandler> {
    return { malformed: true, body, delayMs };
  }

  /** Send a raw HTTP status (e.g. 500) with optional body. */
  static rawStatus(status: number, body = ''): ReturnType<EndpointHandler> {
    return { status, body };
  }

  /** Stop the server and wait for shutdown. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      // Reset state for GC
      this.updateQueue = [];
      this.calls.length = 0;
      this.server.close(() => resolve());
    });
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private dispatch(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', this.baseUrl);
      const path = url.pathname;

      // Extract method name from /bot<token>/<method>
      const method = path.split('/').pop() ?? '';
      const body: Record<string, unknown> = {};
      try {
        if (raw) Object.assign(body, JSON.parse(raw));
      } catch {
        /* malformed body */
      }
      // Parse query params for GET requests
      if (req.method === 'GET') {
        for (const [k, v] of url.searchParams) body[k] = v;
      }
      this.calls.push({ method, body });

      const handler: EndpointHandler =
        this.handlers[method] ??
        (() => ({ envelope: { ok: false, description: 'not found', error_code: 404 } }));
      const result = handler(body);

      // Custom status response
      if ('status' in result) {
        res.writeHead(result.status, { 'Content-Type': 'text/plain' });
        res.end(result.body);
        return;
      }

      // Malformed JSON response
      if ('malformed' in result) {
        if (result.delayMs) {
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(result.body);
          }, result.delayMs);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(result.body);
        return;
      }

      // Normal JSON envelope response
      const json = JSON.stringify(result.envelope);
      if (result.delayMs) {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(json);
        }, result.delayMs);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(json);
    });
  }
}
