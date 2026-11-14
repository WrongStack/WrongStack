import { toErrorMessage } from '@wrongstack/core/utils/error';
import {
  createSurfaceConnectionState,
  decodeProtocolMessage,
  FrameResume,
  markConnectionActivity,
  markConnectionConnecting,
  markConnectionOpen,
  type SurfaceConnectionState,
  stopConnection,
} from '@wrongstack/webui-protocol';
import type { WSClientMessage, WSServerMessage, WSUserMessageImage } from '../types';
import { streamCoalescer } from './stream-coalescer';
import { installWsClientActionMethods, type WsClientActionMethods } from './ws-client-actions';
import { ensureAuthCookie } from './ws-client-auth';
import {
  attemptReconnectHelper,
  bindSocketLifecycle,
  retryNowHelper,
  type WsReconnectHost,
} from './ws-client-connection';
import type { WSSendOptions } from './ws-client-contracts';
import {
  installWsClientDomainMethods,
  type WsClientDomainMethods,
} from './ws-client-domain-methods';
import { WsClientEchoSuppression } from './ws-client-echo';
import { emitToHandlers, routeInboundMessage, type WsClientInboundHost } from './ws-client-inbound';
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
  SWAP_GUARD_MS,
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
   * 180s outlives the server's 120s human-approval window and leaves room for
   * Brain to finish deciding before a reconnect/client sweep forgets the id.
   * RAM-leak audit 2026-08-11, MEDIUM.
   */
  private static readonly PENDING_CONFIRM_TTL_MS = 180_000;
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
   * When the outstanding swap was armed.
   *
   * The duplicate guard in `send()` exists to swallow a double-click, but an
   * unanswered swap used to hold the guard forever: the request was dropped
   * silently and the New Session button became a permanent no-op, with no way
   * back except a page reload. The guard is therefore only a DOUBLE-CLICK
   * guard — a fresh request supersedes an outstanding one that has gone stale.
   */
  private pendingSwapAt = 0;
  /**
   * The session id of the `session.start` currently being dispatched, when it
   * is the answer to THIS client's swap request. Set in `handleMessage`
   * immediately before `emit`, read (and cleared) by `handleSessionStart` via
   * `consumeRequestedSwitch`. Keyed by session id so a grant can never be
   * spent on a different session than the one it was issued for.
   */
  private requestedSwitchSessionId: string | null = null;
  /**
   * Session ids this client has already seen a RESET `session.start` for.
   *
   * Used to recognise the answer to a `session.new`, whose id the client
   * cannot know in advance: the answer is the first RESET announcement naming
   * a session this client has never seen. ONLY RESET announcements are
   * recorded — a plain re-announcement (a model switch, a mode change, another
   * tab's session) says nothing about whether a session is new, and counting
   * those made the answer unrecognisable: the server announces the session it
   * just created once without `reset` and once with it, so the plain one
   * poisoned the set and the authoritative answer could never be matched.
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
  /** Reconnect catch-up: session frames in order, missed ones asked back. */
  readonly frameResume = new FrameResume<WSServerMessage>((frames) => {
    for (const frame of frames) this.handleMessage(frame);
  });
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
   * B-04 (docs/archive/local/audit/webui-full-review-2026-09-03.md).
   */
  private echoSuppression = new WsClientEchoSuppression();

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
            // Replay the plan-quota readings the server already holds. Quota is
            // pushed as it changes, so this only matters for a tab that
            // connected (or reconnected) after a reading landed — without it
            // the chip stays blank until the next turn completes.
            this.send({ type: 'provider.quota.get' });
            resolve();
          },
          onMessage: (msg) => {
            this.connectionState = markConnectionActivity(this.connectionState);
            for (const frame of this.frameResume.gate.accept(msg)) this.handleMessage(frame);
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
        this.lastErrorText = toErrorMessage(err);
        this.setStatus({ state: 'closed', error: this.lastErrorText });
        reject(err);
      }
    });
  }

  private attemptReconnect() {
    attemptReconnectHelper(this as unknown as WsReconnectHost, {
      queueLimit: WrongStackWebSocketClientBase.MAX_QUEUED_MESSAGES,
      maxReconnectAttempts: this.maxReconnectAttempts,
      shouldReconnect: () => this.shouldReconnect,
    });
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
    routeInboundMessage(
      this as unknown as WsClientInboundHost,
      msg,
      WrongStackWebSocketClientBase.PENDING_CONFIRM_TTL_MS,
    );
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
  matchesPendingSwap(payload: { sessionId: string; reset?: boolean }): boolean {
    return matchesPendingSwap(this.pendingSwapTarget, this.seenSessionIds, payload);
  }

  rememberSeenSession(sessionId: string): void {
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
  consumeArmedResend(sessionId: string): void {
    consumeArmedResendHelper(this.armedResends, sessionId, (c, img, fc, s) => {
      (this as unknown as WsClientSessionMethods).sendMessage(c, img, fc, s);
    });
  }

  /**
   * Drop `pendingConfirms` entries whose TTL has passed. Entries are
   * created when a `tool.confirm_needed` message arrives and only
   * removed when the user calls `sendConfirm`; if the user dismisses the
   * prompt UI without responding, the entry would otherwise sit until
   * the WebUI page is closed. The 180s TTL intentionally exceeds the
   * server-authoritative 120s human window and Brain handoff.
   *
   * Runs inline on each new `tool.confirm_needed` insert (cheap: the
   * map is bounded by the number of prompts the user can have open
   * concurrently) and is also called from `disconnect()` during
   * teardown.
   */
  sweepExpiredPendingConfirms(now: number): void {
    sweepExpiredPendingConfirmsHelper(this.pendingConfirms, now);
  }

  emit(msg: WSServerMessage) {
    emitToHandlers(this.handlers, msg);
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
      // The duplicate guard swallows a DOUBLE-CLICK — two requests for the
      // same swap in quick succession, which the server would otherwise
      // process serially and answer with a second, mismatched session. It is
      // deliberately not a permanent lock: an outstanding swap that was never
      // answered (a dropped frame, a session the server refused to announce)
      // used to hold the guard forever, and every later New Session click was
      // dropped silently — the button looked broken and only a page reload
      // brought it back. A fresh request supersedes a stale one.
      const duplicateWithinGuard =
        this.pendingSwapTarget === swapTarget && Date.now() - this.pendingSwapAt < SWAP_GUARD_MS;
      if (duplicateWithinGuard) return false;
      this.pendingSwapTarget = swapTarget;
      this.pendingSwapAt = Date.now();
    }
    if (message.type === 'context.clear') {
      const targetSid =
        (message.payload as { sessionId?: string } | undefined)?.sessionId ?? this.sessionId;
      if (targetSid) {
        streamCoalescer.dropSession(targetSid);
      } else {
        streamCoalescer.dropAll();
      }
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

/** Process-wide client singleton; `url` only applies to the first call. */
export function getWSClient(url?: string): WrongStackWebSocketClient {
  if (!client) {
    client = new WrongStackWebSocketClient(url);
  }
  return client;
}
