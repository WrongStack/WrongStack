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
} from '@wrongstack/webui-protocol';
import { safeId } from '@/lib/utils';
import { hasLane } from '../stores/chat-lanes';
import type {
  WSClientMessage,
  WSModelSwitchResult,
  WSServerMessage,
  WSUserMessageImage,
} from '../types';
import type { ProviderCustomModelWire } from '../types/client-message';
import type { ContextEditorMessage, ContextEditorRemoval } from '../types/runtime';
import { streamCoalescer } from './stream-coalescer';
import { installWsClientActionMethods, type WsClientActionMethods } from './ws-client-actions';
import type { WSSendOptions } from './ws-client-contracts';
import {
  installWsClientDomainMethods,
  type WsClientDomainMethods,
} from './ws-client-domain-methods';
import {
  buildClearModelsMessage,
  buildProviderUpdateMessage,
  buildUndoClearMessage,
} from './ws-client-helpers';
import {
  defaultWsUrl,
  type EventHandler,
  foregroundSessionId,
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
  type: 'note' | 'ask' | 'assign' | 'steer' | 'btw' | 'broadcast' | 'status' | 'result' | 'review';
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
  'memory.sage.listCandidates': 'memory.sage.listCandidates',
  'memory.sage.listPage': 'memory.sage.listPage',
  'memory.sage.remember': 'memory.sage.remember',
  'memory.sage.update': 'memory.sage.update',
  'skills.list': 'skills.list',
  'stats.get': 'stats.get',
  'tools.list': 'tools.list',
};

const CHAT_ECHO_SUPPRESSION_TTL_MS = 30_000;

/**
 * Cadence of the lazy echo-suppression sweep (see ensureEchoSweep). Chosen
 * at 2x the TTL granularity: stale timestamps are released within one
 * sweep interval of expiry without a per-push clock read.
 */
const CHAT_ECHO_SUPPRESSION_SWEEP_MS = 15_000;

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
/**
 * Stand-in target for a `session.new`: the client asked the server to create a
 * session and cannot name it until the answer arrives. Never a real id — the
 * server issues opaque ids, and the leading `#` is not in that alphabet.
 */
const NEW_SESSION_SWAP_TARGET = '#pending-new-session';

/** Bound on `seenSessionIds`; four tabs plus a long tail of retired ones. */
const MAX_SEEN_SESSION_IDS = 64;

/**
 * The session a swap request is asking to land on, or `null` when the message
 * is not a swap request at all. `session.resume` names its target in
 * `payload.id`; `session.new` has none yet.
 */
function resolveSwapTarget(message: WSClientMessage): string | null {
  if (message.type === 'session.new') return NEW_SESSION_SWAP_TARGET;
  if (message.type !== 'session.resume') return null;
  const id = (message as { payload?: { id?: unknown } }).payload?.id;
  return typeof id === 'string' && id.length > 0 ? id : NEW_SESSION_SWAP_TARGET;
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
  /**
   * Wall-clock TTL for a `pendingConfirms` entry. The map is keyed by a
   * server-issued id and is only deleted by `sendConfirm`; a permission
   * prompt that the user dismisses without sending a decision (panel
   * unmounted, view switched, tab backgrounded) would otherwise leak the
   * key for the lifetime of the WebUI tab. The entry's stored value is
   * an empty object, so the leak is symbolic — but the unbounded key
   * space is the actual risk, swept here on every insert + on disconnect.
   * 60s is generous for a human-perceived permission prompt and matches
   * the typical reconnect window.
   * RAM-leak audit 2026-08-11, MEDIUM.
   */
  private static readonly PENDING_CONFIRM_TTL_MS = 60_000;
  private sessionId: string | null = null;
  /**
   * The session this client is currently waiting to be switched to, or
   * `NEW_SESSION_SWAP_TARGET` when it asked the server to CREATE one and does
   * not know the id yet. `null` means no swap is outstanding.
   *
   * This used to be a bare boolean (`sessionSwapPending`), and that is what
   * made four tabs fight each other: `session.start` arrives for background
   * sessions too (another tab's resume answer landing late, a server-side
   * re-announce, a broadcast), and an unkeyed flag was consumed by whichever
   * announcement happened to arrive first. The grant meant for the tab the
   * user clicked was then spent on a DIFFERENT session — which took the
   * foreground — and the click's own answer, arriving with the flag already
   * cleared, was treated as an unrequested re-announce and ignored. That is
   * exactly "I click tab 2 and get tab 1's transcript".
   */
  private pendingSwapTarget: string | null = null;
  /**
   * The session id of the `session.start` currently being dispatched, when it
   * is the answer to THIS client's swap request. Set in `handleMessage`
   * immediately before `emit`, read (and cleared) by `handleSessionStart` via
   * `consumeRequestedSwitch`. Keyed by session id so a grant can never be
   * spent on a different session than the one it was issued for.
   */
  private requestedSwitchSessionId: string | null = null;
  /**
   * Session ids this client has already seen a `session.start` for. Used to
   * recognise the answer to a `session.new`, whose id the client cannot know
   * in advance: the answer is the first RESET announcement naming a session
   * this client has never seen.
   */
  private readonly seenSessionIds = new Set<string>();
  /**
   * Should the next `session.subscribe` ask the server for each tab's
   * transcript? True for a page's first declaration and after every
   * reconnect; cleared as soon as one goes out. See `subscribeSessions`.
   */
  private replayOnNextSubscribe = true;
  /** Last declared open-tab set — see `subscribeSessions`. */
  private subscribedSessionIds: string[] = [];
  /** Minimum spacing between automatic `session_not_ready` retries for ONE session. */
  private static readonly NOT_READY_RETRY_COOLDOWN_MS = 15_000;
  /** Upper bound on parked retries, so tab churn cannot grow the map forever. */
  private static readonly MAX_ARMED_RESENDS = 8;
  /**
   * Auto-retry parking for a `session_not_ready` refusal: the message the
   * server refused while its session had no live writer, held until that
   * session's `session.start` announces it open again. See `armNotReadyResend`.
   */
  private readonly armedResends = new Map<
    string,
    {
      content: string;
      freshContext?: boolean | undefined;
      images?: WSUserMessageImage[] | undefined;
      armedAt: number;
    }
  >();
  /** Stored last close reason / error message so the UI can show "what
   *  went wrong" while reconnecting instead of a generic spinner. */
  private lastErrorText: string | undefined;
  private statusListeners = new Set<(s: WsStatus) => void>();
  private currentStatus: WsStatus = { state: 'connecting' };
  /**
   * requestId-keyed suppression map. Each `echoToChat: false` request mints
   * a requestId, stamps it on the outgoing payload, and registers it here
   * with an expiry timestamp. The server echoes the same requestId back
   * in its response, and `consumeSuppressedChatEcho` looks it up to drop
   * the chat echo only for the matching request — not for any other
   * in-flight request of the same type from a different tab.
   *
   * The TTL (30 s) and a periodic sweep are the safety net for a
   * requestId that was minted but whose response never arrived (chat
   * unmounted mid-flight, server crash, etc.) so the map cannot grow
   * unboundedly.
   *
   * B-04 (docs/audit/webui-full-review-2026-09-03.md).
   */
  private suppressedChatEchoes = new Map<string, number>();
  private echoSweepTimer: ReturnType<typeof setInterval> | null = null;
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

  /**
   * Stamp the outgoing payload with the session it belongs to.
   *
   * `sessionId` is an explicit override for anything sent on behalf of a tab
   * that is NOT in front — draining a background lane's queue, aborting a
   * background run. Without it the payload inherits the foreground session and
   * the background tab's message starts a run in the wrong session; that is
   * the send-side twin of the cross-tab transcript bleed.
   *
   * "The foreground" is the LANE POINTER — the same value the chat surface
   * renders from — and nothing else. Two weaker sources used to stand in for
   * it and both mis-addressed runs:
   *
   *  - `useSessionStore().session?.id` is the lane's SessionInfo, which is
   *    null between opening a tab and its `session.start` landing. A message
   *    typed in that window fell through to the next fallback.
   *  - `this.sessionId` is whatever session announced LAST on this socket,
   *    background tabs included. Stamping it sent the foreground tab's message
   *    into another tab's session: its transcript grew there, its `isLoading`
   *    never cleared here (no `run.result` for a session this tab never ran),
   *    and when that other session was mid-run the server answered with
   *    "Agent.run() is already in progress on this instance".
   */
  withSession<T extends Record<string, unknown>>(
    payload: T,
    sessionId?: string | undefined,
  ): T & { sessionId?: string } {
    const targetId = sessionId || foregroundSessionId();
    return targetId ? { ...payload, sessionId: targetId } : payload;
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
          // The outstanding swap died with the socket; a reconnect re-announces
          // from scratch and must not inherit a grant nobody is waiting on.
          this.pendingSwapTarget = null;
          this.requestedSwitchSessionId = null;
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

  /**
   * Drain the offline queue onto a freshly-opened socket.
   *
   * Two hazards, both fatal before this guard:
   *
   * 1. `send()` calls `this.ws.send(...)` unguarded. The socket can race
   *    OPEN → CLOSING between the readyState check and the actual write (a
   *    normal server restart does it), which throws `InvalidStateError`. This
   *    runs from `onopen` BEFORE `resolve()`, so the throw skipped the
   *    resolve, the connect promise never settled, `.finally()` never cleared
   *    `connectPromise`, and every later `connect()` — including
   *    `attemptReconnect` and `retryNow` — returned that dead promise. The tab
   *    was offline for good with the banner stuck on "reconnecting".
   * 2. If the socket is not OPEN, `send()` re-queues the message it was handed
   *    while this loop keeps shifting — an infinite loop on the main thread.
   *    Draining into a local array first makes the loop finite by construction.
   */
  private flushMessageQueue() {
    const pending = this.messageQueue.splice(0);
    this.messageQueueChars = 0;
    // `messageQueueWeights` is a WeakMap keyed by the message objects; once
    // the queue no longer references them the entries drop on their own.
    for (const msg of pending) {
      try {
        this.send(msg);
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'ws.flush_failed',
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  private handleMessage(msg: WSServerMessage) {
    if (msg.type === 'tool.confirm_needed') {
      const payload = msg.payload as never as {
        id: string;
        toolName: string;
        input: unknown;
        suggestedPattern: string;
      };

      // Sweep expired entries before adding the new one so the map never
      // grows past the active-prompt surface. Done inline (rather than on
      // a timer) because the per-insert cost is bounded by the number of
      // prompts the user could plausibly have open at once, and that's
      // also the natural upper bound for the map itself.
      this.sweepExpiredPendingConfirms(Date.now());
      this.pendingConfirms.set(payload.id, {
        expiresAtMs: Date.now() + WrongStackWebSocketClientBase.PENDING_CONFIRM_TTL_MS,
      });
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
        reset?: boolean;
        protocolVersion?: number;
        protocolCapabilities?: string[];
      };
      const negotiation = negotiateProtocol(payload);
      this.sessionId = payload.sessionId;
      this.protocolVersion = negotiation.version;
      this.protocolCapabilities = new Set(negotiation.capabilities);
      // Did THIS client ask for THIS session? `session.start` also arrives
      // unrequested (boot, model switch, a server-side re-announce, another
      // tab's answer landing late), and an unrequested one must update its own
      // lane WITHOUT yanking the user out of the tab they are working in.
      //
      // Matching is by session id, never "a swap was outstanding": an answer
      // for some other session must leave the outstanding grant alone so the
      // tab the user actually clicked can still claim it.
      this.requestedSwitchSessionId = this.matchesPendingSwap(payload) ? payload.sessionId : null;
      if (this.requestedSwitchSessionId) this.pendingSwapTarget = null;
      this.rememberSeenSession(payload.sessionId);
      this.emit(msg);
      // Handlers have now bound and replayed this session's lane — the right
      // moment to replay a message the server refused with `session_not_ready`
      // while the session was not open in the runtime. One-shot: see
      // `armNotReadyResend` / `consumeArmedResend`.
      this.consumeArmedResend(payload.sessionId);
      return;
    } else if (
      msg.type === 'error' &&
      (msg.payload.phase === 'session.new' || msg.payload.phase === 'session.resume')
    ) {
      this.pendingSwapTarget = null;
    }

    this.emit(msg);
  }

  /**
   * Is this `session.start` the answer to the swap this client is waiting on?
   *
   * A resume names its target, so it matches by id. A `session.new` cannot —
   * the server invents the id — so its answer is recognised as the first RESET
   * announcement naming a session this client has never seen. Requiring
   * `reset` keeps an unrelated first-sight announcement (a background tab the
   * server announces on its own) from consuming the grant.
   */
  private matchesPendingSwap(payload: { sessionId: string; reset?: boolean }): boolean {
    const target = this.pendingSwapTarget;
    if (!target || !payload.sessionId) return false;
    if (target !== NEW_SESSION_SWAP_TARGET) return target === payload.sessionId;
    return payload.reset === true && !this.seenSessionIds.has(payload.sessionId);
  }

  private rememberSeenSession(sessionId: string): void {
    if (!sessionId) return;
    if (this.seenSessionIds.size >= MAX_SEEN_SESSION_IDS) {
      // Insertion-ordered: drop the oldest rather than the whole set, so the
      // four live tabs are never forgotten in one step.
      const oldest = this.seenSessionIds.values().next();
      if (!oldest.done) this.seenSessionIds.delete(oldest.value);
    }
    this.seenSessionIds.add(sessionId);
  }

  /**
   * Claim the "this client asked to switch here" grant for ONE session.
   *
   * Read by `handleSessionStart` to decide whether the announced session takes
   * the foreground or merely updates its own lane. Keyed by session id and
   * one-shot: a later re-announce of the same session does not inherit the
   * grant, and an announce for a DIFFERENT session cannot spend it.
   */
  consumeRequestedSwitch(sessionId: string): boolean {
    if (!sessionId || this.requestedSwitchSessionId !== sessionId) return false;
    this.requestedSwitchSessionId = null;
    return true;
  }

  /**
   * Park ONE automatic retry for a `session_not_ready` refusal.
   *
   * The refusal means the session is not open in the runtime yet (placeholder
   * writer — the F5-restored-tab case): resuming it and resending exactly what
   * was refused is safe and expected. The cooldown makes the retry one-shot
   * per window, so a resume→announce→resend→refuse race degrades to the
   * ordinary error bubble on the second refusal instead of ping-ponging
   * forever. Returns false while on cooldown — the caller then renders the
   * refusal as a normal error (manual recovery).
   */
  armNotReadyResend(
    sessionId: string,
    message: {
      content: string;
      freshContext?: boolean | undefined;
      images?: WSUserMessageImage[] | undefined;
    },
  ): boolean {
    if (!sessionId) return false;
    const now = Date.now();
    const held = this.armedResends.get(sessionId);
    if (held && now - held.armedAt < WrongStackWebSocketClientBase.NOT_READY_RETRY_COOLDOWN_MS) {
      return false;
    }
    if (this.armedResends.size >= WrongStackWebSocketClientBase.MAX_ARMED_RESENDS) {
      const oldest = this.armedResends.keys().next();
      if (!oldest.done) this.armedResends.delete(oldest.value);
    }
    this.armedResends.set(sessionId, { ...message, armedAt: now });
    return true;
  }

  /**
   * Fire the armed retry once the refused session announces itself live.
   *
   * Guarded on the lane still existing: a tab closed while the retry was
   * parked must not start a server-side run nobody is watching.
   */
  private consumeArmedResend(sessionId: string): void {
    const held = this.armedResends.get(sessionId);
    if (!held) return;
    this.armedResends.delete(sessionId);
    if (!hasLane(sessionId)) return;
    this.sendMessage(held.content, held.images, held.freshContext === true, sessionId);
  }

  /**
   * Drop `pendingConfirms` entries whose TTL has passed. Entries are
   * created when a `tool.confirm_needed` message arrives and only
   * removed when the user calls `sendConfirm`; if the user dismisses the
   * prompt UI without responding, the entry would otherwise sit until
   * the WebUI page is closed. A 60s TTL is generous for a permission
   * prompt — anything unresolved by then is treated as abandoned.
   *
   * Runs inline on each new `tool.confirm_needed` insert (cheap: the
   * map is bounded by the number of prompts the user can have open
   * concurrently) and is also called from `disconnect()` during
   * teardown.
   */
  private sweepExpiredPendingConfirms(now: number): void {
    for (const [id, entry] of this.pendingConfirms) {
      if (entry.expiresAtMs <= now) this.pendingConfirms.delete(id);
    }
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
    // B-04 ordering invariant: the requestId stamp MUST happen before the
    // message is serialized. `serialized` below is the exact string handed
    // to `ws.send()` on the open-socket path — stamping the payload only
    // after that string exists would register a suppression id that never
    // reaches the server, so the server could not echo it back and every
    // suppressed reply would leak into the chat transcript. (Registering
    // the mint up front means a frame later dropped by the too-large or
    // swap-dedupe guards below can leave an unused entry; the TTL + sweep
    // bound such orphans by design.)
    if (options.echoToChat === false) {
      const responseType = CHAT_ECHO_RESPONSE_BY_REQUEST[message.type];
      if (responseType) {
        // Mint a correlation id (or use the one the caller supplied) and
        // register it for the response. B-04: with the previous FIFO-by-type
        // queue, tab A's suppression could swallow tab B's `/tools` reply
        // if the two responses interleaved across tabs. Keying the
        // suppression by requestId makes the drop exactly one-to-one: the
        // server echoes the requestId, and only the matching response
        // consumes its slot. Unstamped responses are left alone, so a
        // chat-issued command that produces a response of the same type
        // is never silently lost.
        const requestId =
          options.requestId ?? `suppress_${Date.now()}_${safeId().slice(0, 8)}`;
        this.suppressedChatEchoes.set(
          requestId,
          Date.now() + CHAT_ECHO_SUPPRESSION_TTL_MS,
        );
        this.ensureEchoSweep();
        // The mint must reach the server for the response to be
        // correlatable; piggy-back on the existing payload.
        const targetPayload = (
          (message as { payload?: Record<string, unknown> }).payload ?? {}
        ) as Record<string, unknown>;
        targetPayload.requestId = requestId;
        (message as { payload?: Record<string, unknown> }).payload = targetPayload;
      }
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
    // A swap request names where the user wants to go. Two rapid requests for
    // the SAME target are a double-click and are deduped; two requests for
    // DIFFERENT targets are the user changing their mind, and the newest one
    // must win. The old guard dropped the second unconditionally, so clicking
    // tab A then tab B before A's answer landed left the server on A while
    // this client had already pointed its lane at B — and A's answer then
    // dragged the surface back to A. Nothing ever re-asked for B.
    const swapTarget = resolveSwapTarget(message);
    if (swapTarget) {
      if (this.pendingSwapTarget === swapTarget) return false;
      this.pendingSwapTarget = swapTarget;
    }
    if (message.type === 'context.clear') {
      // The conversation in front is being emptied — buffered tokens have
      // nowhere to land.
      streamCoalescer.dropAll();
    } else if (message.type === 'session.new' || message.type === 'session.resume') {
      // A tab swap must NOT discard the outgoing tab's buffered tokens:
      // dropping them truncated a streaming reply mid-sentence whenever the
      // user opened or switched a tab. Flush them into the session they
      // belong to instead; handleSessionStart snapshots that transcript.
      streamCoalescer.flushAll();
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

  /**
   * Consume one UI-originated response that must not be mirrored into chat.
   *
   * B-04: the suppression map is keyed by requestId. The caller passes the
   * full message so we can read the `requestId` echoed by the server; only
   * the matching request consumes a slot. A response with no (or
   * unrecognised) requestId is left alone — that is exactly the case the
   * previous FIFO queue got wrong: tab A's suppression swallowed tab B's
   * chat-issued `/tools` reply when B's response happened to arrive first.
   *
   * Pass `msg` whenever the caller has it (the central WS_HANDLERS path
   * does). When `msg` is missing, no suppression is possible — that
   * matches the audit's instruction that suppression must be correlated
   * end-to-end, never type-keyed.
   */
  consumeSuppressedChatEcho(responseType: string, msg?: WSServerMessage): boolean {
    if (!msg) return false;
    const requestId = (msg.payload as { requestId?: unknown } | undefined)?.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) return false;
    const expiry = this.suppressedChatEchoes.get(requestId);
    if (expiry === undefined) return false;
    this.suppressedChatEchoes.delete(requestId);
    // An expired requestId MUST NOT consume — a late response from a
    // request whose chat-echo window has elapsed would otherwise be
    // dropped silently. The sweep keeps the map tidy, but on the consume
    // path we still let the response through so the user sees the late
    // reply in their chat.
    return expiry > Date.now();
  }

  /**
   * Lazy periodic sweep for `suppressedChatEchoes`. TTL trimming otherwise
   * runs only on consume — a requestId that was minted but never consumed
   * (chat view unmounted, user on another screen) would otherwise retain
   * its timestamp indefinitely. The sweep bounds retention to TTL + one
   * sweep interval and self-stops when the map empties, so no timer runs
   * for clients that never suppress. RAM-leak audit 2026-08-11 Finding 4
   * / fix 2026-08-16.
   */
  private ensureEchoSweep(): void {
    if (this.echoSweepTimer) return;
    this.echoSweepTimer = setInterval(() => {
      this.sweepSuppressedChatEchoes(Date.now());
    }, CHAT_ECHO_SUPPRESSION_SWEEP_MS);
  }

  private sweepSuppressedChatEchoes(now: number): void {
    for (const [requestId, expiry] of this.suppressedChatEchoes) {
      if (expiry <= now) this.suppressedChatEchoes.delete(requestId);
    }
    if (this.suppressedChatEchoes.size === 0 && this.echoSweepTimer) {
      clearInterval(this.echoSweepTimer);
      this.echoSweepTimer = null;
    }
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

  sendMessage(
    content: string,
    images?: WSUserMessageImage[],
    freshContext = false,
    sessionId?: string | undefined,
  ): string {
    const id = `msg_${Date.now()}_${safeId().slice(0, 8)}`;
    const payload = this.withSession(
      {
        id,
        content,
        timestamp: Date.now(),
        ...(freshContext ? { freshContext: true } : {}),
        ...(images && images.length > 0 ? { images } : {}),
      },
      sessionId,
    );
    // A manual send on this session supersedes any armed auto-retry — firing
    // the parked replay after this would duplicate the user's own message.
    if (payload.sessionId) this.armedResends.delete(payload.sessionId);
    this.send({ type: 'user_message', payload });
    return id;
  }

  /** Ask the server for the persisted Chimera review reports of a session. */
  getChimeraReports(sessionId?: string | undefined): void {
    this.send({
      type: 'chimera.reports.list',
      payload: this.withSession({ sessionId: sessionId ?? '' }, sessionId),
    });
  }

  adviseTopic(
    prompt: string,
    timeoutMs = 10_000,
  ): Promise<Extract<WSServerMessage, { type: 'topic.advice_result' }>['payload']> {
    type Advice = Extract<WSServerMessage, { type: 'topic.advice_result' }>['payload'];
    const requestId = safeId();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Advice) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(result);
      };
      const off = this.on('topic.advice_result', (message) => {
        if (message.payload.requestId !== requestId) return;
        finish(message.payload);
      });
      const timer = setTimeout(() => {
        finish({
          requestId,
          suggestNewContext: false,
          confidence: 0,
          reason: 'Topic check timed out; continuing in the current context.',
          source: 'local',
        });
      }, timeoutMs);
      this.send({
        type: 'topic.advice',
        payload: this.withSession({ requestId, prompt }),
      });
    });
  }

  /** Send a mailbox message of the given type (btw, steer, note, etc.)
   *  to a target agent/role. Returns the requestId for response tracking. */
  sendMailboxMessage(opts: WSMailboxSendOptions, sessionId?: string | undefined): string {
    const requestId = `mbox_${Date.now()}_${safeId().slice(0, 8)}`;
    this.send({
      type: 'mailbox.send',
      payload: this.withSession(
        {
          requestId,
          to: opts.to,
          type: opts.type,
          audience: opts.audience ?? 'all',
          subject: opts.subject,
          body: opts.body,
          priority: opts.priority ?? 'normal',
        },
        sessionId,
      ),
    });
    return requestId;
  }

  sendAbort(sessionId?: string | undefined) {
    this.send({
      type: 'abort',
      payload: this.withSession({}, sessionId),
    });
  }

  /**
   * Tell the server every session this page is displaying.
   *
   * Four tabs share ONE socket, so the server cannot infer the open set from
   * the last message's `sessionId` — it would filter the other three tabs'
   * runs out of every broadcast, and a background tab would simply stop
   * producing output. Re-sent in full on every tab open/close (it replaces,
   * it does not merge) and re-sent on reconnect, since the server forgets the
   * set with the connection.
   */
  subscribeSessions(sessionIds: string[]): void {
    const unique = Array.from(new Set(sessionIds.filter((id) => typeof id === 'string' && id)));
    if (unique.length === 0) return;
    if (unique.length === this.subscribedSessionIds.length) {
      const same = unique.every((id, i) => id === this.subscribedSessionIds[i]);
      if (same) return;
    }
    this.subscribedSessionIds = unique;
    // The FIRST declaration on a connection asks for every tab's transcript
    // back; later ones ask for none.
    //
    // What the browser restored after a reload is a localStorage copy, and
    // that copy is capped (`MAX_PERSISTED_MESSAGES`) and carries no audit
    // markers — so a long conversation came back as its last couple of
    // hundred messages, silently, with the compaction and provider-error
    // lines missing. The journal on the server is the complete record, so the
    // page asks for it once per connection and the panes are then identical
    // to what they showed before the reload.
    //
    // Later subscribes are tab opens and closes. The one id that changed
    // already received its transcript from the `session.resume` that opened
    // it, and the tabs that did not change must NOT be re-sent one: their
    // lanes are live and a replay is the poorer record.
    const replayFor = this.replayOnNextSubscribe ? unique : [];
    this.replayOnNextSubscribe = false;
    this.send({
      type: 'session.subscribe',
      payload: this.withSession({
        sessionIds: unique,
        ...(replayFor.length > 0 ? { replayFor } : {}),
      }),
    });
  }

  /** Forget the declared set so the next call re-sends it (used on reconnect). */
  clearSessionSubscription(): void {
    this.subscribedSessionIds = [];
    // A fresh connection means the panes may be showing a stale or truncated
    // localStorage copy: ask for the journal again with the re-declaration.
    this.replayOnNextSubscribe = true;
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
        payload: this.withSession({ provider, model, requestId }),
      });
    });
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
    this.pendingSwapTarget = null;
    this.requestedSwitchSessionId = null;
    // Drop any unresolved permission prompts. Even expired entries can linger
    // if a `tool.confirm_needed` doesn't recur to sweep them; on explicit
    // teardown release everything unconditionally so a long-lived tab that
    // reconnects many times doesn't drag prompts from earlier sessions.
    this.pendingConfirms.clear();
    // Stop the echo-suppression sweep and drop any stale timestamps.
    if (this.echoSweepTimer) {
      clearInterval(this.echoSweepTimer);
      this.echoSweepTimer = null;
    }
    this.suppressedChatEchoes.clear();
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
installWsClientDomainMethods(WrongStackWebSocketClientBase);

export type WrongStackWebSocketClient = WrongStackWebSocketClientBase &
  WsClientActionMethods &
  WsClientDomainMethods;

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
