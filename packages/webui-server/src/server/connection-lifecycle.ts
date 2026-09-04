import type { WebSocket } from 'ws';
import type { PendingConfirm } from './pending-confirms.js';
import { resolveAllPendingConfirms } from './pending-confirms.js';
import { messageSessionId, runWithDispatchSession } from './ws-utils.js';

type OutboundMessage = { type: string; payload: unknown };
type ProtocolIssue = { code: string; message: string };
type DecodeResult<Message> = { ok: true; message: Message } | { ok: false; issue: ProtocolIssue };

/**
 * Payload delivered to the `onSecurityRejection` callback when the decoder
 * trips a security-relevant issue code (`unsafe_key` or `too_deep`).
 */
export interface SecurityRejectionEvent {
  /** Decoder issue code that triggered the alert. */
  issueCode: string;
  /** Human-readable issue message from the decoder. */
  issueMessage: string;
  /** Event name logged alongside this rejection. */
  eventName: string;
  /** Per-connection id — `undefined` when the client lacks this field. */
  connectionId?: string;
  /** Session id bound to this connection — `null` when the client has none. */
  sessionId?: string | null;
  /** Agent id from the server-wide client context. */
  agentId?: string;
  /** Project root from the server-wide client context. */
  projectRoot?: string;
}

/**
 * Minimum shape a client must expose for verbose logging to attach
 * per-connection identity to rejection logs. The connection lifecycle
 * reads these fields defensively (`?.connId`, `?.sessionId`), so any
 * subset is fine — but consumers should declare the shape on their
 * `Client` type to make the contract explicit and avoid silent drops
 * when fields are renamed.
 */
export interface ClientWithConnectionInfo {
  /** Unique per-connection id — defaults to `undefined` when absent. */
  connId?: string;
  /** Session id bound to this connection — may be `null` when not yet known. */
  sessionId?: string | null;
  /** Remote socket address captured when the connection is accepted. */
  remoteAddress?: string;
}

/**
 * Message types that never count against a connection's rate budget.
 *
 * WS-029: the limiter shipped disabled because it "was tripping during normal
 * use" — it charged keepalives, which the browser sends on a timer regardless
 * of what the user is doing, so an idle tab could exhaust the budget. Exempting
 * them is what makes a default limit safe to turn on; raising the number
 * without fixing the counting would only move the same bug further out.
 *
 * Keep this list to traffic that is genuinely automatic and cheap. Anything a
 * caller can use to make the server do work belongs in the budget.
 */
export const RATE_LIMIT_EXEMPT_TYPES: ReadonlySet<string> = new Set(['ping', 'pong']);

export interface ConnectionLifecycleOptions<Client, Request, Message> {
  clients: Map<WebSocket, Client>;
  pendingConfirms: Map<string, PendingConfirm>;
  authenticate?: (ws: WebSocket, request: Request) => boolean | Promise<boolean>;
  createClient: (ws: WebSocket, connectionId: string) => Client;
  registerClient: (ws: WebSocket) => void;
  unregisterClient?: (ws: WebSocket) => void;
  onClose?: (ws: WebSocket, client: Client | undefined) => void;
  decode: (raw: string) => DecodeResult<Message>;
  dispatch: (ws: WebSocket, client: Client, message: Message) => Promise<void>;
  send: (ws: WebSocket, message: OutboundMessage) => void;
  sessionPayload: (payload: Record<string, unknown>) => Record<string, unknown>;
  buildInitialPayload: () => Promise<Record<string, unknown>>;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  confirmDrainGraceMs?: number;
  rateLimitMessage?: string;
  /**
   * Enrich rejection/parse-failure logs with per-connection context so the
   * server can identify the sender of unknown client message types. When
   * false (default), the original `{ level, event, message }` shape is
   * preserved for back-compat with downstream log consumers.
   */
  verboseWsLogging?: boolean;
  /**
   * Connection-level context attached to verbose rejection logs. Note that
   * per-connection identity (`connectionId`, `sessionId`) is sourced from the
   * `client` argument of `logRejection` directly, so it does not need to be
   * duplicated here.
   */
  clientContext?: {
    agentId?: string;
    projectRoot?: string;
  };
  /**
   * Optional consumer-supplied log sink. Honored by every error-emitting
   * branch (`webui_server.client_socket_error`, `message_handler_failed`,
   * `session_start_payload_failed`, and the verbose rejection path under
   * `verboseWsLogging`). The `error` argument is typed `unknown` and is the
   * standard Error / string for the three standard branches, while the
   * verbose rejection branch passes the enriched structured payload object
   * (with `connectionId`, `sessionId`, `agentId`, `code`, `type`, etc.) so
   * downstream sinks can index/filter on the extra fields.
   */
  log?: (level: 'warn' | 'error', event: string, error: unknown) => void;
  /**
   * Called when the decoder reports a security-tripwire issue code
   * (`unsafe_key` or `too_deep`). The caller (typically `start-webui.ts`
   * via the connection handler) can use this to send a `to:'*' audience:'leaders'`
   * mailbox message so the running agent-loop is notified immediately of
   * possible exploit attempts or runaway payloads.
   *
   * The callback is fire-and-forget from the lifecycle's perspective: it is
   * invoked with bare `void` (no await) so a slow or throwing consumer never
   * delays the message handler. Wrap any async work in a promise that is
   * intentionally not awaited.
   */
  onSecurityRejection?: ((event: SecurityRejectionEvent) => void) | undefined;
}

/**
 * Canonical WebSocket lifecycle: protection, auth, registration, protocol
 * decode, rate limiting, initial replay, and disconnect cleanup.
 */
export function createConnectionLifecycle<Client, Request, Message>(
  options: ConnectionLifecycleOptions<Client, Request, Message>,
): (ws: WebSocket, request: Request) => Promise<void> {
  const rateLimitMax = options.rateLimitMax ?? 0;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? 60_000;
  const confirmDrainGraceMs = options.confirmDrainGraceMs ?? 30_000;
  let connectionSequence = 0;
  let confirmDrainTimer: ReturnType<typeof setTimeout> | null = null;

  const log = (level: 'warn' | 'error', event: string, error: unknown): void => {
    if (options.log) {
      options.log(level, event, error);
      return;
    }
    const output = JSON.stringify({
      level,
      event,
      message: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
    if (level === 'warn') console.warn(output);
    else console.error(output);
  };

  /**
   * Verbose variant of `log` used for the rejection/parse-failure path only.
   * Adds per-connection context and the decoder issue's code/type when
   * available. Falls back to the standard `log` shape when `verboseWsLogging`
   * is off or no client context has been bound yet.
   */
  const logRejection = (
    level: 'warn' | 'error',
    event: string,
    issueMessage: string,
    issueCode: string | undefined,
    issuePath: string | undefined,
    client: ClientWithConnectionInfo | undefined,
  ): void => {
    if (!options.verboseWsLogging) {
      log(level, event, issueMessage);
      return;
    }
    // The decoder's `unknown_type` issue message has the shape
    // `Unknown <direction> message: <type>`; re-parse the type suffix so
    // log consumers can filter on `type` without parsing the human string.
    let rejectedType: string | undefined;
    if (issueCode === 'unknown_type') {
      const match = /Unknown\s+\S+\s+message:\s+(\S+)/.exec(issueMessage);
      if (match?.[1]) rejectedType = match[1];
    }
    const payload: Record<string, unknown> = {
      level,
      event,
      message: issueMessage,
      timestamp: new Date().toISOString(),
    };
    if (client?.connId) payload['connectionId'] = client.connId;
    if (client?.sessionId) payload['sessionId'] = client.sessionId;
    if (options.clientContext?.agentId) payload['agentId'] = options.clientContext.agentId;
    if (options.clientContext?.projectRoot)
      payload['projectRoot'] = options.clientContext.projectRoot;
    if (client?.remoteAddress) payload['remoteAddress'] = client.remoteAddress;
    if (issueCode) payload['code'] = issueCode;
    if (issuePath) payload['path'] = issuePath;
    if (rejectedType) payload['type'] = rejectedType;
    if (options.log) {
      // Route the enriched structured payload through the consumer-supplied
      // logger so callers that wire a custom sink (e.g. a log aggregator) do
      // not lose verbose rejection entries. The `error` argument is already
      // typed `unknown` on the option contract — this is the one site where
      // we pass an object instead of an Error/string, which is the whole
      // reason verbose mode exists.
      options.log(level, event, payload);
      return;
    }
    const line = JSON.stringify(payload);
    if (level === 'warn') console.warn(line);
    else console.error(line);
  };

  return async (ws, request) => {
    const onError = (error: unknown) => log('warn', 'webui_server.client_socket_error', error);
    if (typeof ws.on === 'function') ws.on('error', onError);
    if (options.authenticate && !(await options.authenticate(ws, request))) {
      if (typeof ws.removeListener === 'function') {
        ws.removeListener('error', onError);
      } else if (typeof (ws as unknown as { off?: unknown }).off === 'function') {
        (ws as unknown as { off: (event: string, fn: unknown) => void }).off('error', onError);
      }
      try {
        ws.close?.(4401, 'Unauthorized');
      } catch {
        /* ignore */
      }
      return;
    }

    const client = options.createClient(ws, `c${++connectionSequence}`);
    options.clients.set(ws, client);
    options.registerClient(ws);

    if (confirmDrainTimer) {
      clearTimeout(confirmDrainTimer);
      confirmDrainTimer = null;
    }
    for (const confirm of options.pendingConfirms.values()) {
      if (confirm.payload) {
        options.send(ws, { type: 'tool.confirm_needed', payload: confirm.payload });
      }
    }

    let messageCount = 0;
    let rateWindowResetAt = Date.now() + rateLimitWindowMs;
    // When true, the connection is in cooldown: frames are still dropped but
    // the user-facing error frame is suppressed so the SimpleUI toast does not
    // re-render on every subsequent frame for the rest of the window. Cleared
    // when the window resets, which is the next time we evaluate `now`.
    let rateLimitNotified = false;

    /**
     * Charge one unit against the window. Returns false when the connection
     * has exceeded its budget and the frame should be dropped.
     */
    const chargeRateLimit = (): boolean => {
      if (!Number.isFinite(rateLimitMax) || rateLimitMax <= 0) return true;
      const now = Date.now();
      if (now > rateWindowResetAt) {
        messageCount = 0;
        rateWindowResetAt = now + rateLimitWindowMs;
        rateLimitNotified = false;
      }
      if (++messageCount <= rateLimitMax) return true;
      if (!rateLimitNotified) {
        rateLimitNotified = true;
        options.send(ws, {
          type: 'error',
          payload: options.sessionPayload({
            phase: 'rate_limit',
            message: options.rateLimitMessage ?? 'Too many messages. Please wait.',
          }),
        });
      }
      return false;
    };

    ws.on('message', async (data) => {
      // WS-029: the limiter used to charge EVERY frame, keepalives included,
      // before the frame was even decoded. That is why it shipped disabled —
      // the comment at its call site records it "was tripping during normal
      // use". A limiter that is off is not a limiter, so rather than raise the
      // number and leave the miscounting in place, the counting is fixed:
      //
      //   - keepalives are exempt (see RATE_LIMIT_EXEMPT_TYPES),
      //   - undecodable frames are charged, because a flood of garbage is
      //     precisely the abuse case and it never reaches a type check.
      const decoded = options.decode(data.toString());
      if (!decoded.ok && !chargeRateLimit()) return;
      if (!decoded.ok) {
        const eventName =
          decoded.issue.message === 'Protocol frame is not valid JSON'
            ? 'webui_server.message_parse_failed'
            : 'webui_server.message_rejected';
        // Severity policy for rejected frames:
        //   - `unknown_type` / `invalid_envelope` / `invalid_type` → warn.
        //     The frame parsed; the server is healthy. The client is sending
        //     a type the server does not know (stale bundle, deprecated type,
        //     extra payload). Not actionable on the server side without a
        //     client deploy — flooding the error channel with this kind of
        //     noise crowds out real server faults.
        //   - `unsafe_key` / `too_deep` → error. The decoder's prototype-
        //     pollution guard (`unsafe_key`) and the depth-limit guard
        //     (`too_deep`) are tripwires for hostile or runaway payloads.
        //     Either an exploit attempt or a buggy client must surface so an
        //     operator can investigate.
        // The parse-failed branch (`message_parse_failed`) follows the same
        // policy via `code` because the decoder tags it `invalid_envelope`.
        const level: 'warn' | 'error' =
          decoded.issue.code === 'unsafe_key' || decoded.issue.code === 'too_deep'
            ? 'error'
            : 'warn';
        // Fire the optional security-rejection callback. This is intentionally
        // fire-and-forget (bare `void`, no `await`) so a slow or throwing
        // consumer never delays the message handler.
        if (
          level === 'error' &&
          options.onSecurityRejection &&
          (decoded.issue.code === 'unsafe_key' || decoded.issue.code === 'too_deep')
        ) {
          const c = client as unknown as ClientWithConnectionInfo | undefined;
          void options.onSecurityRejection({
            issueCode: decoded.issue.code,
            issueMessage: decoded.issue.message,
            eventName,
            ...(c?.connId ? { connectionId: c.connId } : {}),
            ...(c?.sessionId != null ? { sessionId: c.sessionId } : {}),
            ...(options.clientContext?.agentId ? { agentId: options.clientContext.agentId } : {}),
            ...(options.clientContext?.projectRoot
              ? { projectRoot: options.clientContext.projectRoot }
              : {}),
          } as SecurityRejectionEvent);
        }
        logRejection(
          level,
          eventName,
          decoded.issue.message,
          decoded.issue.code,
          (decoded.issue as { path?: string }).path,
          // `client` is typed as the generic `Client`; widen to the
          // connection-info shape defensively. Consumers that declare
          // `Client extends ClientWithConnectionInfo` skip the cast entirely
          // because the structural assignability is already satisfied.
          client as unknown as ClientWithConnectionInfo,
        );
        options.send(ws, {
          type: 'error',
          payload: options.sessionPayload({
            phase: 'parse',
            code: decoded.issue.code,
            message: decoded.issue.message,
          }),
        });
        return;
      }
      const messageType = (decoded.message as { type?: unknown }).type;
      if (
        (typeof messageType !== 'string' || !RATE_LIMIT_EXEMPT_TYPES.has(messageType)) &&
        !chargeRateLimit()
      ) {
        return;
      }
      try {
        // Bind the asking tab for the whole dispatch. Handlers keep sending
        // `key.operation_result` with no session of their own; `send` stamps
        // this one on, so a background tab's "provider key saved" / "commit
        // failed" answer reaches the tab that asked instead of the tab in
        // front. See `runWithDispatchSession` in ws-utils.ts (B-05).
        await runWithDispatchSession(messageSessionId(decoded.message as { payload?: unknown }), () =>
          options.dispatch(ws, client, decoded.message),
        );
      } catch (error) {
        log('error', 'webui_server.message_handler_failed', error);
      }
    });

    ws.on('close', () => {
      const closing = options.clients.get(ws);
      options.clients.delete(ws);
      options.unregisterClient?.(ws);
      options.onClose?.(ws, closing);
      if (options.clients.size === 0 && options.pendingConfirms.size > 0 && !confirmDrainTimer) {
        confirmDrainTimer = setTimeout(() => {
          confirmDrainTimer = null;
          if (options.clients.size === 0) {
            resolveAllPendingConfirms(options.pendingConfirms, 'no');
          }
        }, confirmDrainGraceMs);
        confirmDrainTimer.unref?.();
      }
    });

    try {
      options.send(ws, { type: 'session.start', payload: await options.buildInitialPayload() });
    } catch (error) {
      log('warn', 'webui.session_start_payload_failed', error);
    }
  };
}
