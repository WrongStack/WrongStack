/**
 * WebSocket connection lifecycle for the standalone WebUI server.
 *
 * Phase 1b of the god-module split (issue: God-modules >1500 lines).
 * `startWebUI` in `./index.ts` previously inlined:
 *   - per-connection message rate limiting (state + `checkRateLimit`)
 *   - the `handleConnection` callback registered on both WS servers
 *   - the F5-resilience replay (transcript + usage) shipped to every new
 *     connection so a browser refresh rehydrates without an extra round-trip
 *
 * All of that moves here. The factory returns the `(ws) => void` handler
 * that `startWebUI` registers on `wssPrimary` / `wssSecondary`. Behaviour is
 * preserved verbatim — rate-limit windows, the 2 000-message replay cap, the
 * pending-confirm cleanup on close, and the error swallow on socket errors.
 */
import type { Context, DefaultTokenCounter } from '@wrongstack/core';
import type { WebSocket } from 'ws';

import type { AutoPhaseWebSocketHandler } from './autophase-ws-handler.js';
import type { CollaborationWebSocketHandler } from './collaboration-ws-handler.js';
import type { SddBoardWebSocketHandler } from './sdd-board-ws-handler.js';
import type { SddWizardWebSocketHandler } from './sdd-wizard-ws-handler.js';
import type { SpecsWebSocketHandler } from './specs-ws-handler.js';
import type { TerminalWebSocketHandler } from './terminal-ws-handler.js';
import type { WorktreeWebSocketHandler } from './worktree-ws-handler.js';
import type { ConnectedClient, WSClientMessage } from './types.js';
import { send } from './ws-utils.js';

/** Decision type persisted for a pending tool.confirm_needed prompt. */
type ConfirmDecision = 'yes' | 'no' | 'always' | 'deny';

/** The session.start payload enriched with optional F5-replay fields. */
type SessionStartEnriched = Record<string, unknown>;

export interface ConnectionHandlerOptions {
  /** Live session id — re-read every connect (mutable across /new + resume). */
  getSessionId(): string;
  /** Builds the rich session.start payload (model, costs, cwd, …). */
  sessionStartPayload(): Promise<SessionStartEnriched>;
  /** Token counter — `total()` feeds the replayUsage block. */
  tokenCounter: DefaultTokenCounter;
  /** Agent context — `context.messages` feeds the replayMessages block. */
  context: Context;
  /** Live WS clients map (shared with the dispatcher + broadcaster). */
  clients: Map<WebSocket, ConnectedClient>;
  /** Pending permission confirmations — drained to 'no' on disconnect. */
  pendingConfirms: Map<string, (decision: ConfirmDecision) => void>;
  /** Per-feature WS handlers that register each new client for their feeds. */
  autoPhaseHandler: AutoPhaseWebSocketHandler;
  specsHandler: SpecsWebSocketHandler;
  sddBoardHandler: SddBoardWebSocketHandler;
  sddWizardHandler: SddWizardWebSocketHandler;
  worktreeHandler: WorktreeWebSocketHandler;
  collabHandler: CollaborationWebSocketHandler;
  terminalHandler: TerminalWebSocketHandler;
  /** The inbound message dispatcher (handles parsed WSClientMessage). */
  handleMessage: (ws: WebSocket, client: ConnectedClient, msg: WSClientMessage) => Promise<void>;
}

/**
 * Cap on how many trailing messages are replayed to a reconnecting client.
 * Keeps a runaway session from locking the socket on first paint. Mirrors
 * the constant that used to live inline in `handleConnection`.
 */
const REPLAY_MESSAGE_CAP = 2_000;

/** Per-connection message budget over the rolling window (0 = disabled). */
const RATE_LIMIT_MESSAGES = Number.parseInt(process.env['WEBUI_RATE_LIMIT'] ?? '0', 10);
/** Rolling rate-limit window length. */
const RATE_LIMIT_WINDOW_MS = 60_000;

interface RateBucket {
  count: number;
  resetAt: number;
}

/**
 * Build the `(ws) => void` connection handler.
 *
 * Owns the rate-limit state + the per-process connection-id sequence so two
 * handlers built in the same process don't share buckets. Returns the handler
 * plus a `dispose` for tests; production registers it directly on the servers.
 */
export function createConnectionHandler(
  opts: ConnectionHandlerOptions,
): (ws: WebSocket) => void {
  // Per-connection rate-limit buckets, keyed by connId (NOT sessionId — every
  // client shares the live session.id, so a sessionId key would share one
  // bucket across all tabs).
  const rateLimits = new Map<string, RateBucket>();
  // Monotonic connection id sequence — distinguishes connections that share
  // a session id (multiple tabs / F5 reloads).
  let connSeq = 0;

  const sessionPayload = <T extends Record<string, unknown>>(payload: T): T & { sessionId: string } => {
    const provided = payload['sessionId'];
    const sessionId = typeof provided === 'string' && provided.length > 0 ? provided : opts.getSessionId();
    return { ...payload, sessionId };
  };

  function checkRateLimit(client: ConnectedClient): boolean {
    if (RATE_LIMIT_MESSAGES <= 0) return true; // disabled
    const now = Date.now();
    const key = client.connId;
    const limit = rateLimits.get(key);
    if (!limit || now > limit.resetAt) {
      rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }
    if (limit.count >= RATE_LIMIT_MESSAGES) return false;
    limit.count++;
    return true;
  }

  return function handleConnection(ws: WebSocket): void {
    const client: ConnectedClient = {
      ws,
      sessionId: opts.getSessionId(),
      connectedAt: Date.now(),
      connId: `c${++connSeq}`,
    };
    opts.clients.set(ws, client);

    // F5-resilience: on EVERY new connection (including the page-reload
    // case) we send the current session transcript alongside the bare
    // session.start payload so the client can hydrate its UI without
    // requiring an extra round-trip from the user. Without this, a
    // browser refresh loses the transcript even though the server still
    // holds it. The cap exists so a runaway session can't lock the socket
    // on first paint.
    void opts
      .sessionStartPayload()
      .then(async (payload) => {
        const enriched: SessionStartEnriched = { ...payload };
        try {
          const live = opts.context.messages ?? [];
          const slice = live.length > REPLAY_MESSAGE_CAP ? live.slice(-REPLAY_MESSAGE_CAP) : live;
          if (slice.length > 0) {
            enriched.replayMessages = slice;
          }
          const total = opts.tokenCounter.total();
          if (total.input + total.output + (total.cacheRead ?? 0) + (total.cacheWrite ?? 0) > 0) {
            enriched.replayUsage = {
              input: total.input,
              output: total.output,
              cacheRead: total.cacheRead ?? 0,
              cacheWrite: total.cacheWrite ?? 0,
            };
          }
        } catch {
          // best-effort — replay is non-critical; the chat store can
          // still rehydrate from localStorage.
        }
        send(ws, { type: 'session.start', payload: enriched });
      })
      .catch((err) => {
        // Log at warn level since sessionStartPayload should rarely fail.
        // This prevents silent failures if internal error handling changes.
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'webui.session_start_payload_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      });

    // Register this client with every per-feature WS handler so it receives
    // the right event feeds (autophase phases, specs board, sdd board, …).
    opts.autoPhaseHandler.addClient(ws);
    opts.specsHandler.addClient(ws);
    opts.sddBoardHandler.addClient(ws);
    opts.sddWizardHandler.addClient(ws);
    opts.worktreeHandler.addClient(ws);
    opts.collabHandler.addClient(ws);
    opts.terminalHandler.addClient(ws);

    ws.on('message', async (data) => {
      if (!checkRateLimit(client)) {
        send(ws, {
          type: 'error',
          payload: sessionPayload({
            phase: 'rate_limit',
            message: 'Too many messages. Please wait before sending more.',
          }),
        });
        return;
      }
      try {
        // Prototype-pollution guard: reject messages whose root-level payload
        // contains __proto__, constructor, or prototype keys. These could
        // cause prototype pollution via Object.assign({}, payload) or spread
        // {...payload}. Own-property check only — `in` walks the prototype
        // chain and would reject every plain object.
        const rawObj = JSON.parse(data.toString());
        if (typeof rawObj === 'object' && rawObj !== null) {
          const obj = rawObj as Record<string, unknown>;
          if (
            Object.hasOwn(obj, '__proto__') ||
            Object.hasOwn(obj, 'constructor') ||
            Object.hasOwn(obj, 'prototype')
          ) {
            send(ws, {
              type: 'error',
              payload: sessionPayload({ phase: 'parse', message: 'Invalid message object' }),
            });
          } else {
            await opts.handleMessage(ws, client, rawObj as never as WSClientMessage);
          }
        } else {
          // Non-object JSON (array, string, number…) — pass through.
          await opts.handleMessage(ws, client, rawObj as WSClientMessage);
        }
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'webui.ws_message_parse_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    });

    ws.on('close', () => {
      const closing = opts.clients.get(ws);
      opts.clients.delete(ws);
      if (closing) rateLimits.delete(closing.connId);
      // If the client disconnects while a permission prompt is pending,
      // resolve all pending confirms with 'no' so the agent loop doesn't
      // hang forever waiting for a response that will never come.
      if (opts.pendingConfirms.size > 0) {
        for (const [, resolve] of opts.pendingConfirms) {
          resolve('no');
        }
        opts.pendingConfirms.clear();
      }
    });

    ws.on('error', (err) => {
      // Without this handler an errored socket would crash the process.
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'webui.client_socket_error',
          message: err.message,
          timestamp: new Date().toISOString(),
        }),
      );
    });
  };
}
