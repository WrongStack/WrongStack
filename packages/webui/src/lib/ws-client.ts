import {
  createSurfaceConnectionState,
  decodeProtocolMessage,
  markConnectionActivity,
  markConnectionConnecting,
  markConnectionOpen,
  negotiateProtocol,
  type SurfaceConnectionState,
  stopConnection,
} from '@wrongstack/webui-protocol';
import type { WSClientMessage, WSServerMessage, WSUserMessageImage } from '../types';
import { streamCoalescer } from './stream-coalescer';
import { installWsClientActionMethods, type WsClientActionMethods } from './ws-client-actions';
import { ensureAuthCookie } from './ws-client-auth';
import { bindSocketLifecycle, planReconnectHelper, retryNowHelper } from './ws-client-connection';
import type { WSSendOptions } from './ws-client-contracts';
import {
  installWsClientDomainMethods,
  type WsClientDomainMethods,
} from './ws-client-domain-methods';
import { WsClientEchoSuppression } from './ws-client-echo';
import { enqueueMessage, flushMessageQueueHelper } from './ws-client-queue';
import {
  installWsClientSessionMethods,
  type WSMailboxSendOptions,
  type WsClientSessionMethods,
} from './ws-client-session-methods';
import {
  armNotReadyResendHelper,
  consumeArmedResendHelper,
  matchesPendingSwap,
  rememberSeenSession,
  resolveSwapTarget,
  sweepExpiredPendingConfirmsHelper,
} from './ws-client-swap';
import {
  defaultWsUrl,
  type EventHandler,
  foregroundSessionId,
  type PendingConfirm,
  type WsStatus,
} from './ws-client-utils';

export type { WSSendOptions } from './ws-client-contracts';
export type { WSMailboxSendOptions, WsStatus };

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
  /** Shared with the session-method mixin (`WsClientSessionHost`), which is
   *  installed onto this prototype — hence not private. */
  pendingConfirms: Map<string, PendingConfirm> = new Map();
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
  replayOnNextSubscribe = true;
  /** Last declared open-tab set — see `subscribeSessions`. */
  subscribedSessionIds: string[] = [];
  /**
   * Auto-retry parking for a `session_not_ready` refusal: the message the
   * server refused while its session had no live writer, held until that
   * session's `session.start` announces it open again. See `armNotReadyResend`.
   */
  readonly armedResends = new Map<
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
  private echoSuppression = new WsClientEchoSuppression();

  private get suppressedChatEchoes(): Map<string, number> {
    return this.echoSuppression.suppressedChatEchoes;
  }

  private get echoSweepTimer(): ReturnType<typeof setInterval> | null {
    return this.echoSuppression.echoSweepTimer;
  }

  private set echoSweepTimer(timer: ReturnType<typeof setInterval> | null) {
    this.echoSuppression.echoSweepTimer = timer;
  }

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
   * the C-598 query-string exposure class).
   */
  async ensureAuthCookie(): Promise<void> {
    this.url = await ensureAuthCookie(this.url);
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
    await this.ensureAuthCookie();
    this.connectionState = markConnectionConnecting(this.connectionState);

    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      this.setStatus({ state: 'connecting' });
      const gen = ++this.socketGeneration;

      try {
        const ws = new WebSocket(this.url);
        this.ws = ws;
        ws.binaryType = 'arraybuffer';

        let reconnectScheduled = false;
        const scheduleReconnect = () => {
          if (reconnectScheduled) return;
          reconnectScheduled = true;
          this.attemptReconnect();
        };

        bindSocketLifecycle(ws, {
          isCurrentGeneration: () => this.socketGeneration === gen,
          onOpen: () => {
            this.connectionState = markConnectionOpen(this.connectionState);
            this.lastErrorText = undefined;
            this.setStatus({ state: 'open' });
            this.flushMessageQueue();
            resolve();
          },
          onMessage: (msg) => {
            this.connectionState = markConnectionActivity(this.connectionState);
            this.handleMessage(msg);
          },
          onError: (errText) => {
            this.lastErrorText = errText;
            reject(new Error(errText));
            scheduleReconnect();
          },
          onClose: (reasonText, isInitialFailure) => {
            this.pendingSwapTarget = null;
            this.requestedSwitchSessionId = null;
            if (isInitialFailure) {
              this.lastErrorText = reasonText;
              reject(new Error(reasonText));
              scheduleReconnect();
              return;
            }
            if (reasonText && !this.lastErrorText) {
              this.lastErrorText = reasonText;
            }
            this.attemptReconnect();
          },
          onTimeout: () => {
            if (this.ws === ws) this.ws = null;
            this.lastErrorText = 'Connection timeout';
            reject(new Error('Connection timeout'));
            scheduleReconnect();
          },
        });
      } catch (err) {
        if (this.socketGeneration !== gen) return;
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
    const reconnect = planReconnectHelper(
      this.connectionState,
      this.maxReconnectAttempts,
      WrongStackWebSocketClientBase.MAX_QUEUED_MESSAGES,
    );
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
    const result = retryNowHelper(
      this.currentStatus.state,
      this.reconnectTimer,
      this.connectionState,
      () => this.connect(),
    );
    this.reconnectTimer = result.reconnectTimer;
    this.connectionState = result.connectionState;
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
    const queueState = {
      messageQueue: this.messageQueue,
      messageQueueChars: this.messageQueueChars,
      messageQueueWeights: this.messageQueueWeights,
    };
    flushMessageQueueHelper(queueState, (msg) => this.send(msg));
    this.messageQueueChars = queueState.messageQueueChars;
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
    return matchesPendingSwap(this.pendingSwapTarget, this.seenSessionIds, payload);
  }

  private rememberSeenSession(sessionId: string): void {
    rememberSeenSession(this.seenSessionIds, sessionId);
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
    return armNotReadyResendHelper(this.armedResends, sessionId, message);
  }

  /**
   * Fire the armed retry once the refused session announces itself live.
   *
   * Guarded on the lane still existing: a tab closed while the retry was
   * parked must not start a server-side run nobody is watching.
   */
  private consumeArmedResend(sessionId: string): void {
    consumeArmedResendHelper(this.armedResends, sessionId, (c, img, fc, s) => {
      (this as unknown as WsClientSessionMethods).sendMessage(c, img, fc, s);
    });
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
    sweepExpiredPendingConfirmsHelper(this.pendingConfirms, now);
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
    // message is serialized.
    this.echoSuppression.registerSuppression(message, options);
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
    // A swap request names where the user wants to go.
    const swapTarget = resolveSwapTarget(message);
    if (swapTarget) {
      if (this.pendingSwapTarget === swapTarget) return false;
      this.pendingSwapTarget = swapTarget;
    }
    if (message.type === 'context.clear') {
      streamCoalescer.dropAll();
    } else if (message.type === 'session.new' || message.type === 'session.resume') {
      streamCoalescer.flushAll();
    }
    if (socketOpen) {
      this.ws?.send(serialized);
      return true;
    } else {
      if (options.queueIfDisconnected === false) return false;
      const queueState = {
        messageQueue: this.messageQueue,
        messageQueueChars: this.messageQueueChars,
        messageQueueWeights: this.messageQueueWeights,
      };
      const result = enqueueMessage(
        queueState,
        message,
        serialized,
        maxQueuedMessages,
        maxQueuedChars,
      );
      this.messageQueueChars = queueState.messageQueueChars;
      return result;
    }
  }

  /**
   * Consume one UI-originated response that must not be mirrored into chat.
   *
   * B-04: the suppression map is keyed by requestId.
   */
  consumeSuppressedChatEcho(responseType: string, msg?: WSServerMessage): boolean {
    return this.echoSuppression.consumeSuppressedChatEcho(responseType, msg);
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
    this.echoSuppression.clear();
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
installWsClientSessionMethods(WrongStackWebSocketClientBase);

export type WrongStackWebSocketClient = WrongStackWebSocketClientBase &
  WsClientActionMethods &
  WsClientDomainMethods &
  WsClientSessionMethods;

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
