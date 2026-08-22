import type { Context } from '@wrongstack/core/agent';
import type { Message, SessionEvent, TokenCounter, Usage } from '@wrongstack/core/types';
import {
  buildReplayPayload,
  decodeProtocolFrame,
  protocolAdvertisement,
} from '@wrongstack/webui-protocol';
import type { WebSocket } from 'ws';
import type { CollaborationWebSocketHandler } from './collaboration-ws-handler.js';
import { createConnectionLifecycle } from './connection-lifecycle.js';
import type { GoalWebSocketHandler } from './goal-ws-handler.js';
import type { PendingConfirm } from './pending-confirms.js';
import type { SddBoardWebSocketHandler } from './sdd-board-ws-handler.js';
import type { SddWizardWebSocketHandler } from './sdd-wizard-ws-handler.js';
import type { SpecsWebSocketHandler } from './specs-ws-handler.js';
import type { TerminalWebSocketHandler } from './terminal-ws-handler.js';
import type { ConnectedClient, WSClientMessage } from './types.js';
import type { WorktreeWebSocketHandler } from './worktree-ws-handler.js';
import { send } from './ws-utils.js';

export interface ConnectionHandlerOptions {
  getSessionId(): string;
  sessionStartPayload(): Promise<Record<string, unknown>>;
  tokenCounter: TokenCounter;
  context: Context;
  loadReplay?:
    | (() => Promise<{
        messages: Message[];
        events?: readonly SessionEvent[] | undefined;
        usage?: Usage | undefined;
      } | null>)
    | undefined;
  clients: Map<WebSocket, ConnectedClient>;
  pendingConfirms: Map<string, PendingConfirm>;
  goalHandler: GoalWebSocketHandler;
  specsHandler: SpecsWebSocketHandler;
  sddBoardHandler: SddBoardWebSocketHandler;
  sddWizardHandler: SddWizardWebSocketHandler;
  worktreeHandler: WorktreeWebSocketHandler;
  collabHandler: CollaborationWebSocketHandler;
  terminalHandler: TerminalWebSocketHandler;
  handleMessage: (ws: WebSocket, client: ConnectedClient, msg: WSClientMessage) => Promise<void>;
  /**
   * Forwarded to the connection lifecycle as `onSecurityRejection`. When set,
   * the callback fires on every `unsafe_key` or `too_deep` decoder rejection
   * with connection-context details. See the lifecycle option's doc comment
   * for design constraints (fire-and-forget, no await).
   */
  onSecurityRejection?: (event: import('./connection-lifecycle.js').SecurityRejectionEvent) => void;
}

/**
 * Per-connection message budget, in non-keepalive messages per 60s.
 *
 * WS-029: this was `?? '0'` — OFF by default — with the call site recording
 * that the limiter "was tripping during normal use" because it counted pings
 * and list calls. That reason is now addressed at the source: keepalives are
 * exempt and the charge happens after decode (see RATE_LIMIT_EXEMPT_TYPES),
 * so the budget only counts frames that actually ask the server to do work.
 *
 * 600/60s is deliberately far above interactive use — a burst of ten messages
 * a second, sustained for a minute — so a human at a keyboard cannot reach it
 * while a runaway client or a hostile local page still hits a ceiling. It is a
 * backstop, not a quota.
 *
 * `WEBUI_RATE_LIMIT=0` remains the explicit opt-out.
 */
const DEFAULT_WS_RATE_LIMIT = 600;

const rawRateLimit = process.env['WEBUI_RATE_LIMIT'];
const parsedRateLimit = rawRateLimit ? Number.parseInt(rawRateLimit, 10) : DEFAULT_WS_RATE_LIMIT;
const RATE_LIMIT_MESSAGES =
  Number.isFinite(parsedRateLimit) && parsedRateLimit >= 0
    ? parsedRateLimit
    : DEFAULT_WS_RATE_LIMIT;

/**
 * When true, rejection/parse-failure logs include per-connection context
 * (connectionId, sessionId, agentId, projectRoot, remoteAddress, the rejected
 * message type, and the decoder issue code) so operators can identify the
 * sender of unknown client message types — for example the recent
 * `mailbox.status` rejections whose sender is otherwise indistinguishable.
 *
 * Off by default to preserve the original log shape for downstream consumers.
 * Enable with `WEBUI_VERBOSE_WS=1` (or `=true`).
 */
const VERBOSE_WS_LOGGING =
  process.env['WEBUI_VERBOSE_WS'] === '1' || process.env['WEBUI_VERBOSE_WS'] === 'true';

function readRemoteAddress(ws: WebSocket): string | undefined {
  const socket = (ws as WebSocket & { _socket?: { remoteAddress?: unknown } })._socket;
  return typeof socket?.remoteAddress === 'string' ? socket.remoteAddress : undefined;
}

export function createConnectionHandler(
  options: ConnectionHandlerOptions,
): (ws: WebSocket) => void {
  const handlers = [
    options.goalHandler,
    options.specsHandler,
    options.sddBoardHandler,
    options.sddWizardHandler,
    options.worktreeHandler,
    options.collabHandler,
    options.terminalHandler,
  ];
  // Server-wide identity for verbose rejection logs. `connectionId`,
  // `sessionId`, and `remoteAddress` are captured per connection on the client;
  // `agentId` and `projectRoot` come from the server-wide Context.
  const clientContext = {
    agentId: options.context.agentId,
    projectRoot: options.context.projectRoot,
  };
  const lifecycle = createConnectionLifecycle<ConnectedClient, undefined, WSClientMessage>({
    clients: options.clients,
    pendingConfirms: options.pendingConfirms,
    verboseWsLogging: VERBOSE_WS_LOGGING,
    clientContext,
    ...(options.onSecurityRejection ? { onSecurityRejection: options.onSecurityRejection } : {}),
    createClient: (ws, connectionId) => {
      const remoteAddress = VERBOSE_WS_LOGGING ? readRemoteAddress(ws) : undefined;
      return {
        ws,
        sessionId: options.getSessionId(),
        connectedAt: Date.now(),
        connId: connectionId,
        ...(remoteAddress !== undefined ? { remoteAddress } : {}),
      };
    },
    registerClient: (ws) => {
      for (const handler of handlers) handler.addClient(ws);
    },
    decode: (raw) => decodeProtocolFrame(raw, 'client') as never,
    dispatch: options.handleMessage,
    send,
    sessionPayload: (payload) => {
      const provided = payload['sessionId'];
      const sessionId =
        typeof provided === 'string' && provided.length > 0 ? provided : options.getSessionId();
      return { ...payload, sessionId };
    },
    rateLimitMax: RATE_LIMIT_MESSAGES,
    rateLimitMessage: 'Too many messages. Please wait before sending more.',
    buildInitialPayload: async () => {
      const payload = { ...(await options.sessionStartPayload()) };
      const advertisement = protocolAdvertisement();
      const priorCapabilities = Array.isArray(payload['protocolCapabilities'])
        ? payload['protocolCapabilities'].filter((item): item is string => typeof item === 'string')
        : [];
      payload['protocolVersion'] = advertisement.protocolVersion;
      payload['protocolCapabilities'] = [
        ...new Set([...priorCapabilities, ...advertisement.protocolCapabilities]),
      ];
      if (
        typeof options.context.lastRequestTokens === 'number' &&
        options.context.lastRequestTokens > 0
      ) {
        payload['lastInputTokens'] = options.context.lastRequestTokens;
      }
      try {
        const replay = await options.loadReplay?.();
        // No durable store wired: fall back to the live conversation, which has
        // no event stream behind it — markers are simply absent in that mode.
        Object.assign(
          payload,
          buildReplayPayload({
            messages: replay?.messages ?? options.context.messages ?? [],
            events: replay?.events,
            usage: replay?.usage ?? options.tokenCounter.total(),
          }),
        );
      } catch {
        // Replay is best-effort; the client may still hydrate local state.
      }
      return payload;
    },
  });
  return (ws) => {
    void lifecycle(ws, undefined);
  };
}
