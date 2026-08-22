/**
 * ACP v1 server-side protocol handler.
 *
 * Receives JSON-RPC requests from an external ACP client (Zed, JetBrains
 * Junie, VS Code ACP extension, etc.) over stdio and answers them per the
 * v1 spec. See https://agentclientprotocol.com/protocol/v1/overview.
 */
import { randomUUID } from 'node:crypto';
import {
  type ACPMessage,
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
  AgentCapabilities,
  ClientCapabilities,
  PromptCapabilities,
  ProtocolHandlerOptions,
  RunTurn,
  RunTurnApi,
  RunTurnInput,
  RunTurnPermissionRequest,
  RunTurnResult,
  SessionConfigOption,
  SessionMode,
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

  constructor(opts: ProtocolHandlerOptions) {
    this.transport = opts.transport;
    this.defaultCwd = opts.defaultCwd;
    this.runTurn = opts.runTurn;
    this.onSessionNew = opts.onSessionNew ?? (() => {});
    this.modes = opts.modes ?? DEFAULT_MODES;
    this.configOptions = opts.configOptions ?? [];
    this.agentName = opts.agentName ?? 'wrongstack';
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
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOut.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingOut.set(id, { resolve, reject, timer });
      this.transport.send(toWire({ jsonrpc: '2.0', id, method, params })).catch((e: unknown) => {
        clearTimeout(timer);
        this.pendingOut.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  private maybeResolvePending(m: ACPMessage): void {
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
      store: this.store,
      replayFor: this.replayFor,
      seedFor: this.seedFor,
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
      await this.sendError(id, -32000, 'Not initialized');
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
          return await handleSessionNewOp(this.sessionContext(), id, params);
        case 'session/load':
          return await handleSessionLoadOp(this.sessionContext(), id, params);
        case 'session/resume':
          return await this.handleSessionResume(id, params);
        case 'session/close':
          return await this.handleSessionClose(id, params);
        case 'session/delete':
          return await this.handleSessionDelete(id, params);
        case 'session/prompt':
          return await handleSessionPromptOp(this.sessionContext(), id, params);
        case 'session/set_mode':
          return await handleSetModeOp(this.sessionContext(), id, params);
        case 'session/set_config_option':
          return await handleSetConfigOptionOp(this.sessionContext(), id, params);
        case 'session/list':
          return await this.handleSessionList(id);
        case 'session/fork':
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
      buildInitializeResult(this.agentName, this.modes, this.configOptions),
    );
    return false;
  }

  private async handleAuthenticate(id: string | number, _params: unknown): Promise<boolean> {
    await this.sendResult(id, { outcome: 'unauthenticated' });
    return false;
  }

  private async handleLogout(id: string | number, _params: unknown): Promise<boolean> {
    await this.sendResult(id, {});
    return false;
  }

  private async handleSessionResume(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { sessionId?: unknown; cwd?: unknown; mcpServers?: unknown };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
    const existing = sessionId ? this.sessions.get(sessionId) : undefined;

    if (existing) {
      existing.updatedAt = new Date().toISOString();
      await this.sendResult(id, {
        initialMode: {
          currentModeId: existing.modeId,
          availableModes: this.modes,
        },
      });
      return false;
    }

    await this.sendError(id, -32000, `session not found: ${sessionId}`);
    return false;
  }

  private async handleSessionClose(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { sessionId?: unknown };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;

    if (!session) {
      await this.sendError(id, -32000, `session not found: ${sessionId}`);
      return false;
    }

    session.abort.abort();
    this.sessions.delete(sessionId!);
    this.disposeSession(sessionId!);

    await this.sendResult(id, {});
    return false;
  }

  private async handleSessionDelete(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { sessionId?: unknown };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;

    if (!sessionId) {
      await this.sendError(id, -32000, `session not found: ${sessionId}`);
      return false;
    }

    if (!this.sessions.has(sessionId)) {
      await this.sendResult(id, { configOptions: [...this.configOptions] });
      return false;
    }
    const session = this.sessions.get(sessionId)!;
    session.abort.abort();
    this.sessions.delete(sessionId);
    this.disposeSession(sessionId);

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
      -32000,
      'provider configuration not available through ACP; use wstack auth',
    );
    return false;
  }

  private async handleProvidersDisable(id: string | number, _params: unknown): Promise<boolean> {
    await this.sendResult(id, {});
    return false;
  }

  private async handleMcpMessage(id: string | number, _params: unknown): Promise<boolean> {
    await this.sendError(id, -32000, 'MCP message routing not available through ACP');
    return false;
  }

  private async handleSessionList(id: string | number): Promise<boolean> {
    const sessions = Array.from(this.sessions.values()).map((s) => {
      const out: { sessionId: string; cwd: string; updatedAt: string; title?: string } = {
        sessionId: s.id,
        cwd: s.cwd,
        updatedAt: s.updatedAt,
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
    try {
      await this.store.save(state, history ?? this.replayFor?.(state.id));
    } catch {
      // persistence is best-effort
    }
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

/** Internal deterministic seam used by the per-file coverage suite. */
export const protocolHandlerCoverage = { errorToJsonRpc };
