/**
 * ACP v1 server-side protocol handler.
 *
 * Receives JSON-RPC requests from an external ACP client (Zed, JetBrains
 * Junie, VS Code ACP extension, etc.) over stdio and answers them per the
 * v1 spec. See https://agentclientprotocol.com/protocol/v1/overview.
 */
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import {
  ACP_ERROR,
  type ACPMessage,
  type AuthGateResult,
  type ClientCapabilities,
  type ProtocolHandlerOptions,
  type RunTurn,
  type SessionConfigOption,
  type SessionMode,
  type SessionPersistence,
  type SessionState,
  toWire,
  WRONGSTACK_VERSION,
} from './protocol-contract.js';
import {
  handleSessionForkOp,
  handleSessionLoadOp,
  handleSessionNewOp,
  handleSessionPromptOp,
  handleSetConfigOptionOp,
  handleSetModeOp,
  type ProtocolSessionContext,
} from './protocol-session-management.js';
import {
  buildInitializeResult,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MODES,
  errorToJsonRpc,
} from './protocol-session-ops.js';

export type {
  AuthGateResult,
  ClientCapabilities,
  McpServer,
  ProtocolHandlerOptions,
  RunTurn,
  RunTurnApi,
  RunTurnInput,
  RunTurnPermissionRequest,
  RunTurnResult,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionPersistence,
  SessionState,
} from './protocol-contract.js';
export { WRONGSTACK_VERSION };

export class ACPProtocolHandler {
  private readonly transport: ProtocolHandlerOptions['transport'];
  private readonly defaultCwd: string;
  private readonly runTurn: RunTurn;
  private readonly onSessionNew: (state: SessionState) => void;
  private readonly modes: readonly SessionMode[];
  private readonly configOptions: readonly SessionConfigOption[];
  private readonly sessionConfigOptions: ProtocolHandlerOptions['sessionConfigOptions'];
  private readonly agentVersion: string;
  private readonly authGate: (() => Promise<AuthGateResult>) | undefined;
  private readonly agentName: string;
  private readonly replayFor:
    | ((sessionId: string) => Array<{ sessionUpdate: string; content: unknown }>)
    | undefined;
  private readonly seedFor:
    | ((sessionId: string, history: Array<{ sessionUpdate: string; content: unknown }>) => void)
    | undefined;
  private readonly disposeFor: ((sessionId: string) => void) | undefined;
  private readonly maxSessions: number;
  private readonly store: SessionPersistence | undefined;

  private initialized = false;
  private clientCapabilities: ClientCapabilities = {};
  private readonly sessions = new Map<string, SessionState>();
  private nextId = 1;

  // Outbound request correlation (server → client requests, e.g.
  // session/request_permission). Keyed by our own `srv_N` ids.
  private readonly pendingOut = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextOutId = 1;
  private readonly promptRequests = new Map<string | number, string>();
  private readonly persistenceWrites = new Map<string, Promise<void>>();

  constructor(opts: ProtocolHandlerOptions) {
    this.transport = opts.transport;
    this.defaultCwd = opts.defaultCwd;
    this.runTurn = opts.runTurn;
    this.onSessionNew = opts.onSessionNew ?? (() => {});
    this.modes = opts.modes ?? DEFAULT_MODES;
    this.configOptions = opts.configOptions ?? [];
    this.sessionConfigOptions = opts.sessionConfigOptions;
    this.agentName = opts.agentName ?? 'wrongstack';
    this.agentVersion = opts.agentVersion?.trim() || WRONGSTACK_VERSION;
    this.authGate = opts.authGate;
    this.replayFor = opts.replayFor;
    this.seedFor = opts.seedFor;
    this.disposeFor = opts.disposeFor;
    this.maxSessions =
      Number.isFinite(opts.maxSessions) && (opts.maxSessions as number) > 0
        ? Math.floor(opts.maxSessions as number)
        : DEFAULT_MAX_SESSIONS;
    this.store = opts.store;
    if (typeof this.transport.onMessage === 'function') {
      this.transport.onMessage((m) => this.maybeResolvePending(m));
    }
  }

  /**
   * Send a request to the client and await its response. Used for
   * server-initiated calls like `session/request_permission`. Rejects on
   * timeout or transport error so the caller can pick a safe fallback.
   */
  private request(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    const id = `srv_${this.nextOutId++}`;
    const sessionId = (params as { sessionId?: string } | null)?.sessionId;
    // `terminal/release` runs from `runTerminal`'s `finally` block after a turn
    // is cancelled to kill the client-side process; binding it to the already-
    // aborted turn signal would fail closed before the release reaches the wire.
    const signal =
      method !== 'terminal/release' && sessionId
        ? this.sessions.get(sessionId)?.abort.signal
        : undefined;
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pendingOut.delete(id);
      };
      const fail = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const abort = (): void => {
        fail(new Error('client request cancelled'));
        void this.transport
          .send(toWire({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: id } }))
          .catch(() => {});
      };
      const timer = setTimeout(() => {
        fail(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (signal?.aborted) {
        fail(new Error('client request cancelled'));
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      this.pendingOut.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: fail,
        timer,
      });
      this.transport.send(toWire({ jsonrpc: '2.0', id, method, params })).catch((e: unknown) => {
        fail(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  private maybeResolvePending(m: ACPMessage): void {
    if (m.result === undefined && m.error === undefined) return;
    const id = (m as { id?: unknown }).id;
    if (typeof id !== 'string') return;
    const pending = this.pendingOut.get(id);
    if (!pending) return;
    this.pendingOut.delete(id);
    clearTimeout(pending.timer);
    const err = (m as { error?: { message?: string } }).error;
    if (err) pending.reject(new Error(err.message ?? 'client request failed'));
    else pending.resolve((m as { result?: unknown }).result);
  }

  /**
   * Process one inbound message. Returns true if this was a terminal
   * message (rare; reserved for future use by the server's own
   * shutdown signal).
   */
  async handleMessage(msg: unknown): Promise<boolean> {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };

    // Response (we never initiate requests, but be defensive).
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      this.maybeResolvePending(msg as ACPMessage);
      return false;
    }

    // Request (has id, has method, no result/error)
    if (m.id !== undefined && typeof m.method === 'string') {
      return this.handleRequest(m.id as string | number, m.method, m.params);
    }

    // Notification (no id, has method)
    if (typeof m.method === 'string') {
      return this.handleNotification(m.method, m.params);
    }

    return false;
  }

  /** Abort all active turns and drop session state. */
  close(): void {
    for (const [sessionId, session] of this.sessions) {
      session.abort.abort();
      this.disposeSession(sessionId);
    }
    this.sessions.clear();
    for (const [, p] of this.pendingOut) {
      clearTimeout(p.timer);
      p.reject(new Error('protocol handler closed'));
    }
    this.pendingOut.clear();
  }

  private disposeSession(sessionId: string): void {
    try {
      this.disposeFor?.(sessionId);
    } catch {
      // Session teardown must continue even if an integration hook fails.
    }
  }

  private sessionContext(): ProtocolSessionContext {
    return {
      sessions: this.sessions,
      maxSessions: this.maxSessions,
      defaultCwd: this.defaultCwd,
      modes: this.modes,
      configOptions: this.configOptions,
      sessionConfigOptions: this.sessionConfigOptions,
      store: this.store,
      replayFor: this.replayFor,
      seedFor: this.seedFor,
      disposeFor: this.disposeFor,
      onSessionNew: this.onSessionNew,
      allocId: () => this.allocId(),
      persist: (state, history) => this.persist(state, history),
      sendNotification: (params) => this.sendNotification(params),
      sendError: (id, code, message, data) => this.sendError(id, code, message, data),
      sendResult: (id, result) => this.sendResult(id, result),
      request: (method, params, timeoutMs) => this.request(method, params, timeoutMs),
      runTurn: this.runTurn,
      clientCapabilities: this.clientCapabilities,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // Requests
  // ────────────────────────────────────────────────────────────────────

  private async handleRequest(
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<boolean> {
    if (method !== 'initialize' && !this.initialized) {
      await this.sendError(id, ACP_ERROR.INVALID_REQUEST, 'Not initialized');
      return false;
    }

    try {
      switch (method) {
        case 'initialize':
          return await this.handleInitialize(id, params);
        case 'authenticate':
          return await this.handleAuthenticate(id, params);
        case 'logout':
          return await this.handleLogout(id, params);
        case 'session/new':
          if (!(await this.passAuthGate(id))) return false;
          return await handleSessionNewOp(this.sessionContext(), id, params);
        case 'session/load':
          if (!(await this.passAuthGate(id))) return false;
          return await handleSessionLoadOp(this.sessionContext(), id, params);
        case 'session/resume':
          if (!(await this.passAuthGate(id))) return false;
          return await this.handleSessionResume(id, params);
        case 'session/close':
          return await this.handleSessionClose(id, params);
        case 'session/delete':
          return await this.handleSessionDelete(id, params);
        case 'session/prompt': {
          const sessionId = (params as { sessionId?: unknown } | null)?.sessionId;
          const tracked =
            typeof sessionId === 'string' &&
            !this.sessions.get(sessionId)?.prompting &&
            !this.promptRequests.has(id);
          if (tracked) {
            this.promptRequests.set(id, sessionId);
          }
          try {
            return await handleSessionPromptOp(this.sessionContext(), id, params);
          } finally {
            if (tracked) this.promptRequests.delete(id);
          }
        }
        case 'session/set_mode':
          return await handleSetModeOp(this.sessionContext(), id, params);
        case 'session/set_config_option':
          return await handleSetConfigOptionOp(this.sessionContext(), id, params);
        case 'session/list':
          return await this.handleSessionList(id, params);
        case 'session/fork':
          if (!(await this.passAuthGate(id))) return false;
          return await handleSessionForkOp(this.sessionContext(), id, params);
        case 'providers/list':
          return await this.handleProvidersList(id, params);
        case 'providers/set':
          return await this.handleProvidersSet(id, params);
        case 'providers/disable':
          return await this.handleProvidersDisable(id, params);
        case 'mcp/message':
          return await this.handleMcpMessage(id, params);
        default:
          await this.sendError(id, -32601, `Unknown method: ${method}`);
          return false;
      }
    } catch (err) {
      const { code, message, data } = errorToJsonRpc(err);
      await this.sendError(id, code, message, data);
      return false;
    }
  }

  private async handleInitialize(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as {
      protocolVersion?: unknown;
      clientCapabilities?: ClientCapabilities;
    };
    if (p.clientCapabilities && typeof p.clientCapabilities === 'object') {
      this.clientCapabilities = p.clientCapabilities;
    }
    this.initialized = true;
    await this.sendResult(
      id,
      buildInitializeResult(this.agentName, this.agentVersion, this.clientCapabilities),
    );
    return false;
  }

  private async handleAuthenticate(id: string | number, _params: unknown): Promise<boolean> {
    // Credentials are the host's `wstack auth` provider config. Re-check them
    // instead of answering success unconditionally: a blind `{}` followed by
    // `auth_required` on session/new would loop an editor between the two.
    if (!(await this.passAuthGate(id))) return false;
    await this.sendResult(id, {});
    return false;
  }

  /**
   * Answer `auth_required` and return false while the host cannot run turns.
   * A gate that throws counts as not ready, with its message.
   */
  private async passAuthGate(id: string | number): Promise<boolean> {
    if (!this.authGate) return true;
    let result: AuthGateResult;
    try {
      result = await this.authGate();
    } catch (err) {
      result = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok) return true;
    // Same shape as the SDK's `RequestError.authRequired`: clients key on the
    // code, and most show only the message, so the login hint goes in it.
    await this.sendError(
      id,
      ACP_ERROR.AUTH_REQUIRED,
      `Authentication required: ${result.message}`,
      {
        details: result.message,
      },
    );
    return false;
  }

  private async handleLogout(id: string | number, _params: unknown): Promise<boolean> {
    await this.sendError(
      id,
      -32601,
      'logout is not supported; manage provider credentials with wstack auth',
    );
    return false;
  }

  private async handleSessionResume(id: string | number, params: unknown): Promise<boolean> {
    return handleSessionLoadOp(this.sessionContext(), id, params, false);
  }

  private async handleSessionClose(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { sessionId?: unknown };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
    if (sessionId === null) {
      await this.sendError(id, ACP_ERROR.INVALID_PARAMS, 'sessionId is required');
      return false;
    }
    const session = this.sessions.get(sessionId);
    // Closing is idempotent: an unknown or already-closed session is closed.
    if (!session) {
      await this.sendResult(id, {});
      return false;
    }

    session.abort.abort();
    this.sessions.delete(sessionId);
    this.disposeSession(sessionId);

    await this.sendResult(id, {});
    return false;
  }

  private async handleSessionDelete(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { sessionId?: unknown };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;

    if (!sessionId) {
      await this.sendError(id, ACP_ERROR.INVALID_PARAMS, 'sessionId is required');
      return false;
    }

    const session = this.sessions.get(sessionId);
    session?.abort.abort();
    this.sessions.delete(sessionId);
    this.disposeSession(sessionId);
    await this.persistenceWrites.get(sessionId);
    await this.store?.delete?.(sessionId);

    await this.sendResult(id, {});
    return false;
  }

  private async handleProvidersList(id: string | number, _params: unknown): Promise<boolean> {
    await this.sendResult(id, {
      providers: [],
      currentProviderId: null,
    });
    return false;
  }

  private async handleProvidersSet(id: string | number, _params: unknown): Promise<boolean> {
    await this.sendError(
      id,
      ACP_ERROR.METHOD_NOT_FOUND,
      'provider configuration not available through ACP; use wstack auth',
    );
    return false;
  }

  private async handleProvidersDisable(id: string | number, _params: unknown): Promise<boolean> {
    await this.sendResult(id, {});
    return false;
  }

  private async handleMcpMessage(id: string | number, _params: unknown): Promise<boolean> {
    await this.sendError(
      id,
      ACP_ERROR.METHOD_NOT_FOUND,
      'MCP message routing not available through ACP',
    );
    return false;
  }

  private async handleSessionList(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { cwd?: unknown; cursor?: unknown };
    // One page holds every session, so no cursor is ever issued; the only
    // valid one is the empty string, which the spec defines as the start.
    const badCursor = p.cursor != null && p.cursor !== '';
    if ((p.cwd != null && (typeof p.cwd !== 'string' || !isAbsolute(p.cwd))) || badCursor) {
      await this.sendError(id, ACP_ERROR.INVALID_PARAMS, 'invalid cwd or cursor');
      return false;
    }
    const known = new Map<string, Partial<SessionState>>(this.sessions);
    for (const entry of (await this.store?.list?.()) ?? []) {
      if (known.has(entry.id)) continue;
      const saved = await this.store?.load(entry.id);
      if (saved?.cwd) known.set(entry.id, { ...saved, id: entry.id });
    }
    const sessions = Array.from(known.values())
      .filter((s) => typeof p.cwd !== 'string' || (s.cwd && resolve(s.cwd) === resolve(p.cwd)))
      .map((s) => {
        const out: { sessionId: string; cwd: string; updatedAt: string; title?: string } = {
          sessionId: s.id!,
          cwd: s.cwd!,
          updatedAt: s.updatedAt ?? '',
        };
        if (s.title !== undefined) out.title = s.title;
        return out;
      });
    await this.sendResult(id, { sessions });
    return false;
  }

  // ────────────────────────────────────────────────────────────────────
  // Notifications
  // ────────────────────────────────────────────────────────────────────

  private async handleNotification(method: string, params: unknown): Promise<boolean> {
    switch (method) {
      case 'session/cancel': {
        const p = (params ?? {}) as { sessionId?: unknown };
        const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        if (session) {
          session.abort.abort();
        }
        return false;
      }
      case '$/cancel_request': {
        const requestId = (params as { requestId?: unknown } | null)?.requestId;
        if (typeof requestId === 'string' || typeof requestId === 'number') {
          const sessionId = this.promptRequests.get(requestId);
          if (sessionId) this.sessions.get(sessionId)?.abort.abort();
        }
        return false;
      }
      case 'exit':
        this.close();
        return true;
      default:
        return false;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Wire helpers
  // ────────────────────────────────────────────────────────────────────

  private async sendNotification(params: unknown): Promise<void> {
    await this.transport.send(toWire({ jsonrpc: '2.0', method: 'session/update', params }));
  }

  private async sendResult(id: string | number, result: unknown): Promise<void> {
    await this.transport.send(toWire({ jsonrpc: '2.0', id, result }));
  }

  private async persist(
    state: SessionState,
    history: Array<{ sessionUpdate: string; content: unknown }> | undefined = undefined,
  ): Promise<void> {
    if (!this.store) return;
    const store = this.store;
    const replay = history ?? this.replayFor?.(state.id);
    const previous = this.persistenceWrites.get(state.id) ?? Promise.resolve();
    const write = previous
      .then(() => store.save(state, replay))
      .then(
        () => {},
        () => {},
      );
    this.persistenceWrites.set(state.id, write);
    await write;
    if (this.persistenceWrites.get(state.id) === write) this.persistenceWrites.delete(state.id);
  }

  private async sendError(
    id: string | number,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    const error: { code: number; message: string; data?: unknown } = { code, message };
    if (data !== undefined) error.data = data;
    await this.transport.send(toWire({ jsonrpc: '2.0', id, error }));
  }

  private allocId(): string {
    return `${this.nextId++}_${randomUUID().replaceAll('-', '')}`;
  }
}
