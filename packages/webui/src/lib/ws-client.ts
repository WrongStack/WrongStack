import {
  createSurfaceConnectionState,
  DEFAULT_SURFACE_CONNECTION_CONFIG,
  decodeProtocolFrame,
  decodeProtocolMessage,
  markConnectionActivity,
  markConnectionConnecting,
  markConnectionOpen,
  negotiateProtocol,
  planConnectionReconnect,
  resetConnection,
  type SurfaceConnectionState,
  stopConnection,
} from '@wrongstack/webui-server/protocol';
import { safeId } from '@/lib/utils';
import type {
  WSClientMessage,
  WSModelSwitchResult,
  WSServerMessage,
  WSUserMessageImage,
} from '../types';
import type { ProviderCustomModelWire } from '../types/client-message';
import type { ContextEditorMessage } from '../types/runtime';
import { streamCoalescer } from './stream-coalescer';
import { installWsClientActionMethods, type WsClientActionMethods } from './ws-client-actions';
import type { WSSendOptions } from './ws-client-contracts';
import {
  buildClearModelsMessage,
  buildProviderUpdateMessage,
  buildUndoClearMessage,
} from './ws-client-helpers';
import {
  defaultWsUrl,
  type EventHandler,
  getTokenFromPageUrl,
  getTokenFromWsUrl,
  httpOriginForAuth,
  type PendingConfirm,
  stripTokenFromAddressBar,
  stripTokenFromUrl,
  type WsStatus,
} from './ws-client-utils';

export type { WSSendOptions } from './ws-client-contracts';
// Re-export types for backward compat
export type { WsStatus };

/** Options for `sendMailboxMessage` — a mailbox message of a given intent
 *  type (btw, steer, note, …) routed to a target agent/role. Shared by the
 *  ws-client method, the `useWebSocket` wrapper, and UI prop contracts. */
export type WSMailboxSendOptions = {
  type:
    | 'note'
    | 'ask'
    | 'assign'
    | 'steer'
    | 'btw'
    | 'broadcast'
    | 'status'
    | 'result'
    | 'review';
  to: string;
  subject: string;
  body: string;
  priority?: 'low' | 'normal' | 'high' | undefined;
  audience?: 'all' | 'leaders' | undefined;
};

const CHAT_ECHO_RESPONSE_BY_REQUEST: Partial<
  Record<WSClientMessage['type'], WSServerMessage['type']>
> = {
  'context.debug': 'context.debug',
  'diag.get': 'diag.get',
  'memory.list': 'memory.list',
  'memory.sage.get': 'memory.sage.get',
  'memory.sage.graph': 'memory.sage.graph',
  'memory.sage.list': 'memory.sage.list',
  'memory.sage.listPage': 'memory.sage.listPage',
  'memory.sage.remember': 'memory.sage.remember',
  'memory.sage.update': 'memory.sage.update',
  'skills.list': 'skills.list',
  'stats.get': 'stats.get',
  'tools.list': 'tools.list',
};

const CHAT_ECHO_SUPPRESSION_TTL_MS = 30_000;

/**
 * Hard cap on the per-response-type suppression array. A response type that
 * is suppressed but never consumed (e.g. the chat view is unmounted or the
 * user is on a different screen) would otherwise keep every push until the
 * TTL expires; cap the array so RAM stays bounded across long sessions.
 * RAM-leak audit 2026-07-31, LOW.
 */
const CHAT_ECHO_SUPPRESSION_MAX_PER_TYPE = 32;

// C-2 fix (Phase 1.4): the auth token is delivered via the HttpOnly
// cookie set by `/ws-auth` (preferred) OR via the `?token=…` query param
// (non-browser fallback). The legacy in-sessionStorage path has been
// removed: every reconnect re-derives the token from the URL or relies
// on the cookie, so the token never sits in client-accessible storage
// where an XSS could lift it. See ws-auth.ts for the full policy and
// security rationale.

function wsUrlCanUseAuthCookie(wsUrl: string): boolean {
  try {
    const ws = new URL(wsUrl);
    const auth = new URL(httpOriginForAuth());
    return ws.hostname === auth.hostname;
  } catch {
    return true;
  }
}
class WrongStackWebSocketClientBase {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private maxReconnectAttempts = 10;
  private shouldReconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  /** Monotonic generation counter. Each openSocket() call increments it;
   *  event handlers capture the generation at creation time and ignore
   *  events from older sockets (e.g. a timed-out socket that fires onopen
   *  late). */
  private socketGeneration = 0;
  private messageQueue: WSClientMessage[] = [];
  private messageQueueChars = 0;
  private readonly messageQueueWeights = new WeakMap<object, number>();
  private connectionState: SurfaceConnectionState = createSurfaceConnectionState();
  // Cap on the offline-queue depth. Past this, send() drops the OLDEST
  // queued message before appending the new one (FIFO drop). Bounds
  // memory under long disconnects and prevents stale commands from
  // flooding the server on reconnect -- a 50k-deep queue of stale
  // user_messages re-firing on next open would just confuse the model
  // and waste its context window. 1000 is a generous budget for a
  // genuine reconnect window (typical reconnect <10s; <50 msg/s).
  private static readonly MAX_QUEUED_MESSAGES = 1000;
  /** Count-only limits are ineffective for image/base64 payloads. */
  private static readonly MAX_QUEUED_CHARS = 16 * 1024 * 1024;
  private pendingConfirms: Map<string, PendingConfirm> = new Map();
  private sessionId: string | null = null;
  private sessionSwapPending = false;
  /** Stored last close reason / error message so the UI can show "what
   *  went wrong" while reconnecting instead of a generic spinner. */
  private lastErrorText: string | undefined;
  private statusListeners = new Set<(s: WsStatus) => void>();
  private currentStatus: WsStatus = { state: 'connecting' };
  private suppressedChatEchoes = new Map<string, number[]>();
  private protocolCapabilities = new Set<string>();
  private protocolVersion: number | null = null;

  supportsCapability(capability: string): boolean {
    return this.protocolCapabilities.has(capability);
  }

  get negotiatedProtocolVersion(): number | null {
    return this.protocolVersion;
  }

  onStatus(fn: (s: WsStatus) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.currentStatus);
    return () => this.statusListeners.delete(fn);
  }

  get status(): WsStatus {
    return this.currentStatus;
  }

  private setStatus(s: WsStatus) {
    this.currentStatus = s;
    for (const fn of this.statusListeners) {
      try {
        fn(s);
      } catch {
        /* listener errors must not break the socket */
      }
    }
  }

  constructor(url?: string) {
    this.url = url ?? defaultWsUrl();
  }

  withSession<T extends Record<string, unknown>>(payload: T): T & { sessionId?: string } {
    return this.sessionId ? { ...payload, sessionId: this.sessionId } : payload;
  }

  /**
   * Exchange a stored token for an HttpOnly auth cookie via `/ws-auth`.
   * Called once before the first connect so subsequent reconnections can
   * drop the `?token=` from the WS URL (C-2 fix — token-in-URL closes
   * the C-598 query-string exposure class). No-op when the cookie is
   * already set, when the server is on a loopback bind (no token
   * required), or when no token is available yet.
   *
   * Failure is non-fatal only for local loopback or explicit public-WS URL
   * flows. Normal remote browser clients need the cookie path so the token does
   * not remain in the WebSocket URL.
   */
  async ensureAuthCookie(): Promise<void> {
    if (typeof window === 'undefined') return;
    if (document.cookie.split(';').some((c) => c.trim().startsWith('ws_token='))) {
      // Cookie already set — the browser sends it automatically on the
      // WS upgrade. Nothing to do.
      if (wsUrlCanUseAuthCookie(this.url)) this.url = stripTokenFromUrl(this.url);
      stripTokenFromAddressBar();
      return;
    }
    // The token, if any, is in the initial page URL or in an explicitly
    // configured WS URL. sessionStorage persistence was removed in the C-2
    // fix: the token must not live in client-accessible storage.
    const token = getTokenFromWsUrl(this.url) ?? getTokenFromPageUrl();
    if (!token) return; // first boot, no token yet — fallback to loopback-bootstrap
    const authUrl = httpOriginForAuth() + `/ws-auth?token=${encodeURIComponent(token)}`;
    try {
      const res = await fetch(authUrl, {
        method: 'GET',
        credentials: 'same-origin',
        // Cache-Control: no-store on the server side. Don't let the
        // browser cache a 401 or replay a stale response.
        cache: 'no-store',
      });
      if (!res.ok) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'ws_client.ws_auth_failed',
            status: res.status,
            timestamp: new Date().toISOString(),
          }),
        );
      } else {
        if (wsUrlCanUseAuthCookie(this.url)) {
          this.url = stripTokenFromUrl(this.url);
        }
        stripTokenFromAddressBar();
      }
    } catch (err) {
      // Network failure on the auth bootstrap may still work for loopback or
      // explicit public-WS URL flows. Log it and let the handshake policy decide.
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'ws_client.ws_auth_error',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async openSocket(): Promise<void> {
    // Bootstrap the HttpOnly auth cookie before the first connect.
    // After this resolves, the browser sends `Cookie: ws_token=…` on
    // the WS upgrade automatically, so we can drop the `?token=` from
    // the URL on subsequent reconnects. Idempotent — the cookie is
    // refreshed only when absent.
    await this.ensureAuthCookie();
    this.connectionState = markConnectionConnecting(this.connectionState);

    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      this.setStatus({ state: 'connecting' });

      // Increment generation so handlers from any previous (timed-out or
      // orphaned) socket are ignored.
      const gen = ++this.socketGeneration;

      try {
        // Prefer the cookie path (C-2 fix): the browser already sends
        // `Cookie: ws_token=…` on the WS upgrade after `ensureAuthCookie`.
        // If the first-load URL carried `?token=...`, ensureAuthCookie()
        // strips it from this.url after the cookie exchange succeeds.
        const ws = new WebSocket(this.url);
        this.ws = ws;
        ws.binaryType = 'arraybuffer';

        const connectTimeout = setTimeout(() => {
          // Timeout: close the orphaned socket so a late onopen doesn't
          // leave it dangling. Only act if this is still the current
          // generation — a newer openSocket() may have already replaced
          // this.ws.
          if (this.ws === ws) {
            try {
              ws.close();
            } catch {
              // close() may throw if already in CLOSING/CLOSED — ignore.
            }
            if (this.ws === ws) this.ws = null;
          }
          this.lastErrorText = 'Connection timeout';
          reject(new Error('Connection timeout'));
          // Timeout should recover just like onerror/onclose do during initial
          // connect.
          scheduleReconnect();
        }, 30_000);

        // Track whether the connection was ever established so onerror and
        // onclose know whether to reject the promise or just attempt a
        // reconnect. Without this, a connection failure leaves callers
        // awaiting connect() hanging forever.
        let established = false;
        let reconnectScheduled = false;

        const scheduleReconnect = () => {
          if (reconnectScheduled) return;
          reconnectScheduled = true;
          this.attemptReconnect();
        };

        ws.onopen = () => {
          if (this.socketGeneration !== gen) return; // stale socket
          clearTimeout(connectTimeout);
          established = true;
          this.connectionState = markConnectionOpen(this.connectionState);
          this.lastErrorText = undefined;
          this.setStatus({ state: 'open' });
          this.flushMessageQueue();
          resolve();
        };

        ws.onmessage = (event) => {
          if (this.socketGeneration !== gen) return; // stale socket
          this.connectionState = markConnectionActivity(this.connectionState);
          const decoded = decodeProtocolFrame(String(event.data), 'server');
          if (decoded.ok) {
            this.handleMessage(decoded.message as WSServerMessage);
          } else {
            console.error(
              JSON.stringify({
                level: 'error',
                event: 'ws_client.message_rejected',
                code: decoded.issue.code,
                message: decoded.issue.message,
                timestamp: new Date().toISOString(),
              }),
            );
          }
        };

        ws.onerror = (error) => {
          if (this.socketGeneration !== gen) return; // stale socket
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'ws_client.error',
              message: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString(),
            }),
          );
          // ErrorEvent in browsers is intentionally opaque — Chrome won't
          // expose the underlying reason for security. We stash a generic
          // hint so the UI has something to display.
          this.lastErrorText = 'Connection error (see browser devtools)';
          if (!established) {
            clearTimeout(connectTimeout);
            reject(new Error(this.lastErrorText));
            // Trigger a reconnect so the client doesn't sit idle after
            // an initial connection failure.
            scheduleReconnect();
          }
        };

        ws.onclose = (ev) => {
          if (this.socketGeneration !== gen) return; // stale socket
          this.sessionSwapPending = false;
          if (!established) {
            clearTimeout(connectTimeout);
            const reason = ev.reason || `Closed with code ${ev.code}`;
            this.lastErrorText = reason;
            reject(new Error(reason));
            // Trigger a reconnect so the client recovers from a
            // failed initial handshake (e.g. server still starting).
            scheduleReconnect();
            return;
          }
          if (ev.reason && !this.lastErrorText) {
            this.lastErrorText = `${ev.reason} (code ${ev.code})`;
          } else if (!this.lastErrorText && ev.code !== 1000) {
            this.lastErrorText = `Closed with code ${ev.code}`;
          }
          this.attemptReconnect();
        };
      } catch (err) {
        if (this.socketGeneration !== gen) return; // stale
        this.lastErrorText = err instanceof Error ? err.message : String(err);
        this.setStatus({ state: 'closed', error: this.lastErrorText });
        reject(err);
      }
    });
  }

  private attemptReconnect() {
    if (!this.shouldReconnect) {
      this.connectionState = stopConnection(this.connectionState);
      this.reconnectTimer = null;
      this.setStatus({ state: 'closed', error: this.lastErrorText ?? 'Disconnected' });
      return;
    }
    const reconnect = planConnectionReconnect(this.connectionState, {
      ...DEFAULT_SURFACE_CONNECTION_CONFIG,
      maxReconnectAttempts: this.maxReconnectAttempts,
      queueLimit: WrongStackWebSocketClientBase.MAX_QUEUED_MESSAGES,
    });
    this.connectionState = reconnect.state;
    if (!reconnect.plan) {
      this.reconnectTimer = null;
      this.setStatus({ state: 'closed', error: this.lastErrorText ?? 'Disconnected' });
      return;
    }
    this.setStatus({
      state: 'reconnecting',
      attempt: reconnect.plan.attempt,
      nextRetryAt: reconnect.plan.retryAt,
      lastError: this.lastErrorText,
    });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        try {
          await this.connect();
        } catch (err) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'ws_client.reconnect_failed',
              message: err instanceof Error ? err.message : String(err),
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }
    }, reconnect.plan.delayMs);
  }

  /** Force an immediate reconnect attempt, bypassing the backoff timer. */
  retryNow(): void {
    if (this.currentStatus.state === 'open') return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connectionState = resetConnection(this.connectionState);
    void this.connect().catch((err) =>
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'ws_client.reconnect_failed',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      ),
    );
  }

  private flushMessageQueue() {
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift();
      if (msg) {
        const weight = this.messageQueueWeights.get(msg as object) ?? JSON.stringify(msg).length;
        this.messageQueueChars = Math.max(0, this.messageQueueChars - weight);
        this.messageQueueWeights.delete(msg as object);
        this.send(msg);
      }
    }
    this.messageQueueChars = 0;
  }

  private handleMessage(msg: WSServerMessage) {
    if (msg.type === 'tool.confirm_needed') {
      const payload = msg.payload as never as {
        id: string;
        toolName: string;
        input: unknown;
        suggestedPattern: string;
      };

      this.pendingConfirms.set(payload.id, {});
      this.emit(msg);
      return;
    }

    if (msg.type === 'session.start') {
      // C-2 fix: the `wsToken` field has been removed from the
      // `session.start` payload. The token is delivered via the
      // HttpOnly cookie set by `/ws-auth` (preferred) or via the
      // `?token=…` query param on the WS URL. There is no
      // client-side persistence of the token (no sessionStorage,
      // no localStorage) — every reconnect re-derives it from
      // the URL or relies on the cookie. See ws-auth.ts.
      const payload = msg.payload as {
        sessionId: string;
        protocolVersion?: number;
        protocolCapabilities?: string[];
      };
      const negotiation = negotiateProtocol(payload);
      this.sessionId = payload.sessionId;
      this.protocolVersion = negotiation.version;
      this.protocolCapabilities = new Set(negotiation.capabilities);
      this.sessionSwapPending = false;
    } else if (
      msg.type === 'error' &&
      (msg.payload.phase === 'session.new' || msg.payload.phase === 'session.resume')
    ) {
      this.sessionSwapPending = false;
    }

    this.emit(msg);
  }

  private emit(msg: WSServerMessage) {
    const handlers = this.handlers.get(msg.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(msg);
        } catch (err) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'ws_client.handler_error',
              messageType: msg.type,
              message: err instanceof Error ? err.message : String(err),
              timestamp: new Date().toISOString(),
            }),
          );
        }
      }
    }
  }

  send(message: WSClientMessage, options: WSSendOptions = {}): boolean {
    const clientClass = this.constructor as typeof WrongStackWebSocketClientBase;
    const maxQueuedMessages = clientClass.MAX_QUEUED_MESSAGES;
    const maxQueuedChars = clientClass.MAX_QUEUED_CHARS;
    const decoded = decodeProtocolMessage(message, 'client');
    if (!decoded.ok) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'ws_client.outbound_message_rejected',
          code: decoded.issue.code,
          message: decoded.issue.message,
          timestamp: new Date().toISOString(),
        }),
      );
      return false;
    }
    const serialized = JSON.stringify(decoded.message);
    const socketOpen = this.ws?.readyState === WebSocket.OPEN;
    if (!socketOpen && serialized.length > maxQueuedChars) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'ws_client.message_queue_full',
          cap: maxQueuedMessages,
          charCap: maxQueuedChars,
          droppedType: message.type,
          reason: 'message_too_large',
          timestamp: new Date().toISOString(),
        }),
      );
      return false;
    }
    const sessionSwap = message.type === 'session.new' || message.type === 'session.resume';
    if (sessionSwap && this.sessionSwapPending) return false;
    if (sessionSwap) this.sessionSwapPending = true;
    if (options.echoToChat === false) {
      const responseType = CHAT_ECHO_RESPONSE_BY_REQUEST[message.type];
      if (responseType) {
        const pending = this.suppressedChatEchoes.get(responseType) ?? [];
        pending.push(Date.now() + CHAT_ECHO_SUPPRESSION_TTL_MS);
        // Drop oldest past the cap so a never-consumed response type can't
        // grow unboundedly. See CHAT_ECHO_SUPPRESSION_MAX_PER_TYPE.
        while (pending.length > CHAT_ECHO_SUPPRESSION_MAX_PER_TYPE) pending.shift();
        this.suppressedChatEchoes.set(responseType, pending);
      }
    }
    if (
      message.type === 'context.clear' ||
      message.type === 'session.new' ||
      message.type === 'session.resume'
    ) {
      streamCoalescer.dropAll();
    }
    if (socketOpen) {
      this.ws?.send(serialized);
      return true;
    } else {
      if (options.queueIfDisconnected === false) return false;
      // FIFO-drop oldest by both count and serialized size. A count-only cap
      // still allows a disconnected tab to retain hundreds of multi-megabyte
      // image messages.
      let firstDropped: WSClientMessage | undefined;
      while (
        this.messageQueue.length > 0 &&
        (this.messageQueue.length >= maxQueuedMessages ||
          this.messageQueueChars + serialized.length > maxQueuedChars)
      ) {
        const dropped = this.messageQueue.shift();
        if (!dropped) break;
        firstDropped ??= dropped;
        const weight =
          this.messageQueueWeights.get(dropped as object) ?? JSON.stringify(dropped).length;
        this.messageQueueChars = Math.max(0, this.messageQueueChars - weight);
        this.messageQueueWeights.delete(dropped as object);
      }
      if (firstDropped) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'ws_client.message_queue_full',
            cap: maxQueuedMessages,
            charCap: maxQueuedChars,
            droppedType: firstDropped.type,
            timestamp: new Date().toISOString(),
          }),
        );
      }
      this.messageQueue.push(message);
      this.messageQueueWeights.set(message as object, serialized.length);
      this.messageQueueChars += serialized.length;
      return true;
    }
  }

  /** Consume one UI-originated response that must not be mirrored into chat. */
  consumeSuppressedChatEcho(responseType: string): boolean {
    const pending = this.suppressedChatEchoes.get(responseType);
    if (!pending) return false;

    const now = Date.now();
    while (pending.length > 0 && pending[0]! <= now) pending.shift();
    if (pending.length === 0) {
      this.suppressedChatEchoes.delete(responseType);
      return false;
    }

    pending.shift();
    if (pending.length === 0) this.suppressedChatEchoes.delete(responseType);
    return true;
  }

  /**
   * Register a handler for a server message type. Two overloads:
   *  - `on('text_delta', (msg) => …)` — msg is narrowed to the matching union
   *    member, so `msg.payload` is statically typed. No cast needed.
   *  - `on(someString, handler)` — for runtime-computed type names; the
   *    handler receives the wider `WSServerMessage`. Backwards compatible.
   */
  on<K extends WSServerMessage['type']>(
    eventType: K,
    handler: (msg: Extract<WSServerMessage, { type: K }>) => void,
  ): () => void;
  on(eventType: string, handler: EventHandler): () => void;
  on(eventType: string, handler: ((msg: never) => void) | EventHandler): () => void {
    let handlers = this.handlers.get(eventType);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(eventType, handlers);
    }
    // The internal table stores the wide EventHandler; the generic overload
    // hands us a narrowed fn that accepts only one union member — widening it
    // to EventHandler (msg: WSServerMessage) is sound because the dispatcher
    // only ever calls it with messages of the registered `eventType`.
    handlers.add(handler as EventHandler);
    return () => handlers?.delete(handler as EventHandler);
  }

  off<K extends WSServerMessage['type']>(
    eventType: K,
    handler: (msg: Extract<WSServerMessage, { type: K }>) => void,
  ): void;
  off(eventType: string, handler: EventHandler): void;
  off(eventType: string, handler: ((msg: never) => void) | EventHandler): void {
    this.handlers.get(eventType)?.delete(handler as EventHandler);
  }

  sendMessage(content: string, images?: WSUserMessageImage[]): string {
    const id = `msg_${Date.now()}_${safeId().slice(0, 8)}`;
    this.send({
      type: 'user_message',
      payload: this.withSession({
        id,
        content,
        timestamp: Date.now(),
        ...(images && images.length > 0 ? { images } : {}),
      }),
    });
    return id;
  }

  /** Send a mailbox message of the given type (btw, steer, note, etc.)
   *  to a target agent/role. Returns the requestId for response tracking. */
  sendMailboxMessage(opts: WSMailboxSendOptions): string {
    const requestId = `mbox_${Date.now()}_${safeId().slice(0, 8)}`;
    this.send({
      type: 'mailbox.send',
      payload: {
        requestId,
        to: opts.to,
        type: opts.type,
        audience: opts.audience ?? 'all',
        subject: opts.subject,
        body: opts.body,
        priority: opts.priority ?? 'normal',
      },
    });
    return requestId;
  }

  sendAbort() {
    this.send({
      type: 'abort',
      payload: this.withSession({}),
    });
  }

  getGitInfo() {
    this.send({ type: 'git.info' });
  }

  /** Request the working-tree change set (file list for the Changes panel). */
  getGitChanges() {
    this.send({ type: 'git.changes' });
  }

  /** Request the before/after content for one changed file. */
  getGitDiff(path: string) {
    this.send({ type: 'git.diff', payload: { path } });
  }

  sendConfirm(id: string, decision: 'yes' | 'no' | 'always' | 'deny') {
    if (this.pendingConfirms.has(id)) {
      this.pendingConfirms.delete(id);
    }
    this.send({
      type: 'tool.confirm_result',
      payload: this.withSession({ id, decision }),
    });
  }

  switchModel(
    provider: string,
    model: string,
    timeoutMs = 8_000,
  ): Promise<WSModelSwitchResult['payload']> {
    const requestId = safeId();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: WSModelSwitchResult['payload']) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(result);
      };
      const off = this.on('model.switch_result', (msg) => {
        const payload = (msg as WSModelSwitchResult).payload;
        if (payload.requestId !== requestId) return;
        finish(payload);
      });
      const timer = setTimeout(() => {
        finish({
          requestId,
          success: false,
          message: 'Model switch timed out. Please try again.',
          provider,
          model,
          runActive: false,
        });
      }, timeoutMs);
      this.send({
        type: 'model.switch',
        payload: { provider, model, requestId },
      });
    });
  }

  // ---- Provider/model health (waiting room) ----

  getProviderStatus() {
    this.send({ type: 'provider.status.get' });
  }

  retryProviderModel(providerId: string, model: string) {
    this.send({ type: 'provider.status.retry', payload: { providerId, model } });
  }

  clearProviderStatus(providerId: string, model: string) {
    this.send({ type: 'provider.status.clear', payload: { providerId, model } });
  }

  newSession() {
    this.send({ type: 'session.new', payload: this.withSession({}) });
  }

  shutdownCodebaseIndexServer(
    timeoutMs = 8_000,
  ): Promise<
    Extract<WSServerMessage, { type: 'codebase.index.server.shutdown_result' }>['payload']
  > {
    type ShutdownResult = Extract<
      WSServerMessage,
      { type: 'codebase.index.server.shutdown_result' }
    >['payload'];
    const requestId = safeId();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: ShutdownResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(result);
      };
      const off = this.on('codebase.index.server.shutdown_result', (message) => {
        if (message.payload.requestId && message.payload.requestId !== requestId) return;
        finish(message.payload);
      });
      const timer = setTimeout(() => {
        finish({
          requestId,
          stopped: false,
          reason: 'Codebase index server shutdown timed out.',
        });
      }, timeoutMs);
      const sent = this.send(
        { type: 'codebase.index.server.shutdown', payload: { requestId } },
        { queueIfDisconnected: false },
      );
      if (!sent) {
        finish({
          requestId,
          stopped: false,
          reason: 'WebSocket is not connected.',
        });
      }
    });
  }

  // ---- Provider/Model/Key management (mirrors TUI/CLI auth-menu) ----

  listProviders() {
    this.send({ type: 'providers.list' });
  }

  listProviderModels(providerId: string) {
    this.send({ type: 'provider.models', payload: { providerId } });
  }

  listSavedProviders() {
    this.send({ type: 'providers.saved' });
  }

  searchProviderModels(query: string, limit?: number) {
    this.send({
      type: 'provider.models.search',
      payload: { query, ...(limit !== undefined ? { limit } : {}) },
    });
  }

  addKey(providerId: string, label: string, apiKey: string) {
    this.send({ type: 'key.add', payload: { providerId, label, apiKey } });
  }

  updateKey(providerId: string, label: string, apiKey: string) {
    this.send({ type: 'key.update', payload: { providerId, label, apiKey } });
  }

  deleteKey(providerId: string, label: string) {
    this.send({ type: 'key.delete', payload: { providerId, label } });
  }

  setActiveKey(providerId: string, label: string) {
    this.send({ type: 'key.set_active', payload: { providerId, label } });
  }

  addProvider(
    id: string,
    family: string,
    baseUrl?: string | undefined,
    apiKey?: string,
    models?: string[] | undefined,
    customModels?: Record<string, ProviderCustomModelWire> | undefined,
  ) {
    this.send({
      type: 'provider.add',
      payload: {
        id,
        family,
        baseUrl,
        apiKey,
        ...(models ? { models } : {}),
        ...(customModels ? { customModels } : {}),
      },
    });
  }

  removeProvider(providerId: string) {
    this.send({ type: 'provider.remove', payload: { providerId } });
  }

  // ---- Subscription OAuth login (ChatGPT / Claude / Copilot) ----

  /** Begin a subscription sign-in; progress arrives as `auth.oauth.status`. */
  startOAuth(kind: 'chatgpt' | 'claude' | 'copilot', providerId?: string) {
    this.send({
      type: 'auth.oauth.start',
      payload: providerId ? { kind, providerId } : { kind },
    });
  }

  /** Manual-paste fallback for loopback flows (port busy / remote browser). */
  submitOAuthCode(kind: 'chatgpt' | 'claude' | 'copilot', input: string) {
    this.send({ type: 'auth.oauth.code', payload: { kind, input } });
  }

  /** Cancel an in-flight subscription sign-in. */
  cancelOAuth(kind: 'chatgpt' | 'claude' | 'copilot') {
    this.send({ type: 'auth.oauth.cancel', payload: { kind } });
  }

  /** Run a health probe against a saved provider's `/v1/models`. */
  probeProvider(providerId: string, timeoutMs?: number) {
    this.send({
      type: 'provider.probe',
      payload: timeoutMs !== undefined ? { providerId, timeoutMs } : { providerId },
    });
  }

  /** Remove the saved model allowlist for a provider. */
  clearProviderModels(providerId: string) {
    this.send(buildClearModelsMessage(providerId));
  }

  /** Restore a previously-cleared model allowlist (pairs with clear). */
  undoProviderClear(providerId: string, previousModels: string[]) {
    this.send(buildUndoClearMessage(providerId, previousModels));
  }

  /** Set/update a single custom model definition (ME-3). */
  setCustomModel(providerId: string, modelId: string, customModel: ProviderCustomModelWire) {
    this.send({
      type: 'provider.custom_models.set',
      payload: { providerId, modelId, customModel },
    });
  }

  /** Remove a single custom model entry (ME-3). */
  removeCustomModel(providerId: string, modelId: string) {
    this.send({
      type: 'provider.custom_models.remove',
      payload: { providerId, modelId },
    });
  }

  /** Update a saved provider's wire config (family / baseUrl / envVars / models / customModels). */
  updateProvider(payload: {
    id: string;
    family?: string | undefined;
    baseUrl?: string | undefined;
    envVars?: string[] | undefined;
    models?: string[] | undefined;
    customModels?: Record<string, ProviderCustomModelWire> | undefined;
  }) {
    this.send(buildProviderUpdateMessage(payload));
  }

  clearContext() {
    this.send({ type: 'context.clear', payload: this.withSession({}) });
  }

  compactContext(aggressive = false) {
    this.send({ type: 'context.compact', payload: this.withSession({ aggressive }) });
  }

  repairContext() {
    this.send({ type: 'context.repair', payload: this.withSession({}) });
  }

  openContextEditor() {
    this.send({ type: 'context.editor.open', payload: this.withSession({}) });
  }

  validateContextEditor(
    baseRevision: string,
    messages: ContextEditorMessage[],
    allowRepair: boolean,
  ) {
    this.send({
      type: 'context.editor.validate',
      payload: this.withSession({ baseRevision, messages, allowRepair }),
    });
  }

  applyContextEditor(baseRevision: string, messages: ContextEditorMessage[], allowRepair: boolean) {
    this.send({
      type: 'context.editor.apply',
      payload: this.withSession({ baseRevision, messages, allowRepair }),
    });
  }

  debugContext(options?: WSSendOptions) {
    this.send({ type: 'context.debug', payload: this.withSession({}) }, options);
  }

  listContextModes() {
    this.send({ type: 'context.modes.list', payload: this.withSession({}) });
  }

  switchContextMode(id: string) {
    this.send({ type: 'context.mode.switch', payload: this.withSession({ id }) });
  }

  createContextMode(mode: {
    id: string;
    name: string;
    description: string;
    thresholds: { warn: number; soft: number; hard: number };
    preserveK: number;
    eliseThreshold: number;
  }) {
    this.send({ type: 'context.mode.create', payload: this.withSession(mode) });
  }

  updateContextMode(
    id: string,
    patch: {
      name?: string | undefined;
      description?: string | undefined;
      thresholds?:
        | { warn?: number | undefined; soft?: number | undefined; hard?: number | undefined }
        | undefined;
      preserveK?: number | undefined;
      eliseThreshold?: number | undefined;
    },
  ) {
    this.send({ type: 'context.mode.update', payload: this.withSession({ id, ...patch }) });
  }

  deleteContextMode(id: string) {
    this.send({ type: 'context.mode.delete', payload: this.withSession({ id }) });
  }

  // ---- Autonomy / Preferences ----

  switchAutonomy(mode: string) {
    this.send({ type: 'autonomy.switch', payload: { mode } });
  }

  updatePrefs(prefs: Record<string, unknown>) {
    this.send({ type: 'prefs.update', payload: prefs });
  }

  getPrefs() {
    this.send({ type: 'prefs.get' });
  }

  disconnect() {
    this.shouldReconnect = false;
    this.connectionState = stopConnection(this.connectionState);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Drop anything queued while disconnected. A subsequent connect()
    // starts fresh -- re-firing stale user_messages or session.commands
    // from before the disconnect would be confusing at best and buggy
    // at worst (e.g. an old 'session.new' overriding the user's new one).
    this.messageQueue.length = 0;
    this.messageQueueChars = 0;
    this.sessionSwapPending = false;
    this.ws?.close();
    this.ws = null;
    // C-2 fix: no client-side token storage to clear — the token lives
    // in the HttpOnly cookie (set by `/ws-auth`, expires on its own) or
    // in the WS URL `?token=…` query param (re-issued on every page load).
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }
}

installWsClientActionMethods(WrongStackWebSocketClientBase);

export type WrongStackWebSocketClient = WrongStackWebSocketClientBase & WsClientActionMethods;

interface WrongStackWebSocketClientConstructor {
  new (url?: string): WrongStackWebSocketClient;
  readonly prototype: WrongStackWebSocketClient;
}

export const WrongStackWebSocketClient =
  WrongStackWebSocketClientBase as unknown as WrongStackWebSocketClientConstructor;

let client: WrongStackWebSocketClient | null = null;

/**
 * Default WS URL derived from the page's host.
 *
 * Subtle gotcha on Windows: when the page is loaded from `http://localhost:3456`,
 * the browser resolves `localhost` *itself* and on Windows it tries IPv6 `[::1]`
 * before IPv4 `127.0.0.1`. If the backend listens only on `127.0.0.1`, every
 * connection attempt to `ws://localhost:3456` first hits the IPv6 socket
 * (refused) and then either gives up or flaps — symptom: "ws disconnect hep".
 *
 * Fix: when the page is on a loopback host (`localhost` / `127.0.0.1` / `::1`),
 * force the WS URL to use the literal IPv4 loopback address. That bypasses the
 * DNS dance entirely. For any other hostname (LAN IP, custom WS_HOST override)
 * we keep the page's hostname so things still "just work".
 *
 * The WS port matches the HTTP port (single-port design): the browser
 * derives it from `window.location` rather than a separate meta tag, so
 * several WebUI instances can run on different ports at once.
 */
export function getWSClient(url?: string): WrongStackWebSocketClient {
  if (!client) {
    client = new WrongStackWebSocketClient(url);
  }
  return client;
}
