import type { IncomingMessage } from 'node:http';
import type { Message, SessionEvent, Usage } from '@wrongstack/core/types';
import { buildReplayPayload, decodeProtocolFrame } from '@wrongstack/webui-protocol';
import type {
  GoalWebSocketHandler,
  PendingConfirm,
  SddBoardWebSocketHandler,
  SddWizardWebSocketHandler,
  SpecsWebSocketHandler,
  TerminalWebSocketHandler,
  WorktreeWebSocketHandler,
} from '@wrongstack/webui-server';
import {
  createConnectionLifecycle,
  verifyClient as verifyWsClient,
} from '@wrongstack/webui-server';
import type { WebSocket } from 'ws';
import type { WSClientMessage, WSServerMessage } from './contracts.js';

export interface ConnectedClient {
  ws: WebSocket;
  /** The session this connection last acted on. */
  sessionId: string | null;
  /**
   * EVERY session this connection is displaying, as declared by
   * `session.subscribe`.
   *
   * One browser page holds up to four tabs on ONE socket, so `sessionId` is
   * only the tab last touched. Anything that asks "is this session still on
   * someone's screen" — the delete guard, per-tab agent eviction — needs the
   * whole set, or it treats three open tabs as abandoned.
   */
  sessionIds?: Set<string> | undefined;
}

export interface ConnectionHandlerDeps {
  host: string;
  wsToken: string;
  requireToken: boolean;
  publicHostnames: string[];
  publicWsUrl: string | undefined;
  clients: Map<WebSocket, ConnectedClient>;
  currentSessionId: () => string;
  goalHandler: GoalWebSocketHandler;
  specsHandler: SpecsWebSocketHandler;
  sddBoardHandler: SddBoardWebSocketHandler;
  sddWizardHandler: SddWizardWebSocketHandler | null;
  worktreeHandler: WorktreeWebSocketHandler;
  terminalHandler: TerminalWebSocketHandler;
  rateLimitMax: number;
  send: (ws: WebSocket, msg: WSServerMessage) => void;
  sessionPayload: <T extends Record<string, unknown>>(payload: T) => T & { sessionId: string };
  handleMessage: (ws: WebSocket, client: ConnectedClient, msg: WSClientMessage) => Promise<void>;
  pendingConfirms: Map<string, PendingConfirm>;
  buildSessionStartPayload: (
    overrides?: Record<string, unknown>,
    needsSetup?: boolean,
  ) => Promise<Record<string, unknown>>;
  loadReplay?:
    | (() => Promise<{
        messages: Message[];
        events?: readonly SessionEvent[] | undefined;
        usage?: Usage | undefined;
      } | null>)
    | undefined;
  loadAgentSessions?:
    | (() => Promise<import('@wrongstack/core/coordination').AgentVirtualSession[]>)
    | undefined;
  needsSetup: boolean;
}

export function createConnectionHandler(
  deps: ConnectionHandlerDeps,
): (ws: WebSocket, req: IncomingMessage) => Promise<void> {
  const clientHandlers = [
    deps.goalHandler,
    deps.specsHandler,
    deps.sddBoardHandler,
    ...(deps.sddWizardHandler ? [deps.sddWizardHandler] : []),
    deps.worktreeHandler,
    deps.terminalHandler,
  ];

  return createConnectionLifecycle<ConnectedClient, IncomingMessage, WSClientMessage>({
    clients: deps.clients,
    pendingConfirms: deps.pendingConfirms,
    // ── Auth trust model ────────────────────────────────────────────────
    // Three layered defenses (see verifyClient in @wrongstack/webui-server/ws-auth):
    //   1. DNS-rebinding guard (Host header must be loopback on loopback bind)
    //   2. Shared-token auth via Cookie (ws_token) or URL query param (?token=)
    //   3. Loopback bootstrap: when requireToken=false (default) AND the server
    //      is bound to a loopback interface, browser clients bypass token auth
    //      entirely — the Origin header being http://localhost is sufficient.
    //
    // COOKIE PERSISTENCE AFTER TOKEN ROTATION:
    // The HttpOnly ws_token cookie, once set by /ws-auth, survives a process
    // restart. On the next process the expectedToken is a fresh random value,
    // so the old cookie alone would fail the token check. However, on a
    // loopback bind with requireToken=false (default), the loopback-bootstrap
    // path at layer 3 accepts the connection before the cookie is ever
    // compared — the old cookie is harmless because no token is needed.
    //
    // This means a token rotation (e.g. the operator sets a new accessToken
    // in config) does NOT invalidate already-distributed cookies for loopback
    // clients. The mitigating factors:
    //   - Loopback bind + requireToken=false already trusts any local process
    //     that can reach 127.0.0.1 — a trivial perimeter.
    //   - A LAN/0.0.0.0 bind with requireToken=true DOES enforce cookie
    //     matching against the new expectedToken on every reconnect.
    // If stronger isolation is needed, set requireToken=true or rebind the
    // server to a non-loopback interface with token enforcement.
    authenticate: (ws, req) => {
      const allowed = verifyWsClient({
        origin: req.headers.origin,
        url: req.url ?? '/',
        hostHeader: req.headers.host,
        remoteAddress: req.socket.remoteAddress,
        cookieHeader: req.headers.cookie,
        wsHost: deps.host,
        expectedToken: deps.wsToken,
        requireToken: deps.requireToken,
        allowedHostnames: deps.publicHostnames,
        allowBrowserUrlToken: Boolean(deps.publicWsUrl),
      });
      if (!allowed) ws.close(4003, 'Forbidden');
      return allowed;
    },
    createClient: (ws) => ({ ws, sessionId: deps.currentSessionId() }),
    // Enrich parse-failure / unknown-type logs with per-connection identity
    // so operators can identify which client sent a malformed frame. The
    // `connectionId`/`sessionId` fields are read from the `client` argument
    // directly inside `logRejection`; the CLI's `ConnectedClient` only has
    // `sessionId` (no per-socket `connId`), so the verbose payload carries
    // `sessionId` only. Server-wide identity (`agentId`/`projectRoot`) isn't
    // in scope at this handler and is omitted.
    verboseWsLogging: true,
    registerClient: (ws) => {
      for (const handler of clientHandlers) handler.addClient(ws);
    },
    decode: (raw) => decodeProtocolFrame(raw, 'client'),
    dispatch: deps.handleMessage,
    send: deps.send,
    sessionPayload: deps.sessionPayload,
    rateLimitMax: deps.rateLimitMax,
    // NOTE — a closed SOCKET is not a stopped run.
    //
    // This used to `abortControllers.delete(client.sessionId)` — a delete
    // WITHOUT an abort, and only for the tab this connection last acted on.
    // Both halves were wrong. The run kept going while `isRunActive` reported
    // `false`, so `session.delete` would happily unlink the journal a live run
    // was still appending to, and the next `user_message` claimed a second
    // lock for the same session and hit `Agent.run() is already in progress`.
    // The other three declared tabs were never touched at all.
    //
    // Doing nothing is the correct behaviour: a background run outlives the
    // tab that started it (the same invariant `retireUndisplayedSessions`
    // honours), and the run's own `finally` releases the lock when it unwinds.
    // A page that comes back is told what is still running by
    // `session.run_state`; a browser that never comes back drains its
    // unanswerable permission prompts through the last-client drain in
    // `connection-lifecycle.ts`, which lets a wedged run finish and release.
    //
    // So there is deliberately NO `onClose` here.
    buildInitialPayload: async () => {
      const payload = { ...(await deps.buildSessionStartPayload({}, deps.needsSetup)) };
      try {
        const replay = await deps.loadReplay?.();
        if (replay) Object.assign(payload, buildReplayPayload(replay));
      } catch {
        // Replay is best-effort.
        console.debug('[WebUI] Failed to load replay');
      }
      try {
        const sessions = await deps.loadAgentSessions?.();
        if (sessions?.length) payload['agentSessions'] = sessions;
      } catch {
        // Worker replay is independently best-effort.
        console.debug('[WebUI] Failed to load agent sessions');
      }
      return payload;
    },
  });
}
