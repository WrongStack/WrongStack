/**
 * ACPSession — v1-correct ACP client.
 *
 * Owns one child process running an ACP-supporting agent (Claude Code,
 * Gemini CLI, Codex CLI, etc.) and translates the wire protocol into
 * a `SubagentRunner`-shaped surface for the rest of WrongStack.
 *
 * Spec: https://agentclientprotocol.com/protocol/v1/overview
 * Design: see ./acp-session.design.md in this directory.
 */
import { type ACPClientTransport, ClientTransport } from '../agent/stdio-transport.js';
import type { ACPMessage } from '../types/acp-messages.js';
import {
  ACP_PROTOCOL_VERSION,
  type AgentCapabilities,
  type AuthMethod,
  type ContentBlock,
  type McpServer,
  type SessionId,
  type SessionInfo,
} from '../types/acp-v1.js';
import { ACP_PACKAGE_VERSION } from '../version.js';
import { cancelLateAcpSession } from './acp-late-session.js';
import { type PendingRequest, rejectPendingRequests, type State } from './acp-request-state.js';
import {
  type AcpSessionAuthHost,
  authenticate as delegateAuthenticate,
  createSessionWithAuth as delegateCreateSessionWithAuth,
  ensureAuthenticated as delegateEnsureAuthenticated,
  logout as delegateLogout,
} from './acp-session-auth.js';
import type { ACPCallbackOptions, ACPResponseSender } from './acp-session-callbacks.js';
import { ACPSessionError, isJsonRpcError } from './acp-session-errors.js';
import type { AcpSessionMessagesHost } from './acp-session-messages.js';
import {
  callbackOptions as callbackOptionsFromHost,
  emitProgress as emitProgressFromHost,
  handleMessage as handleMessageFromHost,
  responseSender as responseSenderFromHost,
} from './acp-session-messages.js';
import {
  type ACPSessionOpContext,
  type AcpSteerOutcome,
  executeDeleteSession,
  executeDisableProvider,
  executeForkSession,
  executeListProviders,
  executeListSessions,
  executeLoadSession,
  executeMcpMessage,
  executeOpenSession,
  executeResumeSession,
  executeSetConfigOption,
  executeSetMode,
  executeSetProvider,
  executeSteer,
} from './acp-session-ops.js';
import { type AcpSessionPromptHost, prompt as promptFromHost } from './acp-session-prompt.js';
import type {
  ACPProgressEvent,
  ACPProgressHandler,
  ACPSessionOptions,
  ACPSessionRunResult,
} from './acp-session-types.js';
import { type ACPSessionScratch, createSessionScratch } from './acp-session-updates.js';
import { FileServer } from './file-server.js';
import { type PermissionPolicy, readOnlyPermissionPolicy } from './permission.js';
import { TerminalServer } from './terminal-server.js';
import { makeTrustBoundaryPermissionPolicy } from './trust-boundary-permission.js';
import {
  WebSocketClientTransport,
  type WebSocketClientTransportOptions,
} from './websocket-transport.js';

export { audioContent, imageContent, textContent } from './acp-session-content.js';
export { ACPSessionError } from './acp-session-errors.js';
export type {
  ACPCapturedDiff,
  ACPCapturedToolCall,
  ACPProgressEvent,
  ACPProgressHandler,
  ACPSessionErrorKind,
  ACPSessionOptions,
  ACPSessionRunResult,
} from './acp-session-types.js';

export class ACPSession {
  private readonly transport: ACPClientTransport;
  private readonly fileServer: FileServer;
  private readonly terminalServer: TerminalServer;
  private readonly permissionPolicy: PermissionPolicy;
  private readonly timeoutMs: number;
  private readonly promptIdleTimeoutMs: number;
  private readonly opts: ACPSessionOptions;
  private transportOff: (() => void) | null = null;
  private readonly callbackAbort = new AbortController();
  private promptCallbackAbort: AbortController | null = null;

  private state: State = 'init';
  private sessionId: SessionId | null = null;
  /** Pending outbound requests (initialize, session/new, session/prompt, etc). */
  private readonly pending = new Map<string | number, PendingRequest>();
  private nextId = 1;
  /** True after close() has been called. */
  private closed = false;

  // Agent-provided info from the initialize handshake
  private agentCapabilities: AgentCapabilities = {};
  private agentInfo: { name: string; title?: string | undefined; version: string } | null = null;
  private authMethods: AuthMethod[] = [];
  /** The agent accepts `_session/steering` (see executeSteer). */
  private steeringSupported = false;
  /** Protocol version negotiated with the agent during initialize. */
  private negotiatedVersion: number = ACP_PROTOCOL_VERSION;

  private constructor(opts: ACPSessionOptions, transport: ACPClientTransport) {
    this.opts = opts;
    this.transport = transport;
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    this.promptIdleTimeoutMs = opts.promptIdleTimeoutMs ?? 10 * 60_000;
    this.fileServer = new FileServer({
      projectRoot: opts.projectRoot,
      allowOutsideRoot: opts.allowOutsideProjectRoot === true,
      ...(opts.fsTimeoutMs !== undefined ? { timeoutMs: opts.fsTimeoutMs } : {}),
    });
    const termOpts: ConstructorParameters<typeof TerminalServer>[0] = {
      projectRoot: opts.projectRoot,
    };
    if (opts.terminalTimeoutMs !== undefined) {
      termOpts.commandTimeoutMs = opts.terminalTimeoutMs;
    }
    if (opts.terminalOutputByteLimit !== undefined) {
      termOpts.outputByteLimit = opts.terminalOutputByteLimit;
    }
    if (opts.terminalMaxCount !== undefined) {
      termOpts.maxTerminals = opts.terminalMaxCount;
    }
    this.terminalServer = new TerminalServer(termOpts);
    if (opts.permissionPolicy && opts.trustBoundary) {
      throw new TypeError('permissionPolicy and trustBoundary are mutually exclusive');
    }
    this.permissionPolicy = opts.trustBoundary
      ? makeTrustBoundaryPermissionPolicy({
          boundary: opts.trustBoundary,
          ...(opts.trustActor ? { actor: opts.trustActor } : {}),
          scope: opts.trustScope ?? { cwd: opts.projectRoot },
          ...(opts.trustAuthContext ? { authContext: opts.trustAuthContext } : {}),
        })
      : (opts.permissionPolicy ?? readOnlyPermissionPolicy);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Public accessors
  // ──────────────────────────────────────────────────────────────────────

  /** Agent capabilities advertised during initialize. */
  getCapabilities(): AgentCapabilities {
    return { ...this.agentCapabilities };
  }

  /** Authentication methods advertised by the agent. */
  getAuthMethods(): AuthMethod[] {
    return [...this.authMethods];
  }

  /** Agent info (name, title, version) from initialize. */
  getAgentInfo(): { name: string; title?: string | undefined; version: string } | null {
    return this.agentInfo;
  }

  /** Whether the agent requires authentication (has auth methods). */
  requiresAuth(): boolean {
    return this.authMethods.length > 0;
  }

  /** Current session id, if one exists. */
  getSessionId(): SessionId | null {
    return this.sessionId;
  }

  /** Protocol version negotiated during initialize. */
  getNegotiatedVersion(): number {
    return this.negotiatedVersion;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Lifecycle — start
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Spawn the child, run the initialize handshake, install the
   * message dispatch, and return a ready session.
   */
  static async start(opts: ACPSessionOptions): Promise<ACPSession> {
    const transportOpts: ConstructorParameters<typeof ClientTransport>[0] = {
      command: opts.command,
      args: opts.args ? [...opts.args] : [],
      handshakeTimeoutMs: 30_000,
      skipHandshakeMarker: true,
    };
    if (opts.env !== undefined) transportOpts.env = opts.env;
    if (opts.cwd !== undefined) transportOpts.cwd = opts.cwd;
    const transport = new ClientTransport(transportOpts);
    try {
      return await ACPSession.attach(opts, transport, `failed to spawn ${opts.command}`);
    } catch (err) {
      try {
        transport.stop();
        /* v8 ignore next 3 - defensive catch around stop */
      } catch {
        // best effort
      }
      throw err;
    }
  }

  /**
   * Connect to a REMOTE ACP agent over a WebSocket instead of spawning a
   * local subprocess. `opts.command` is ignored for the wire (a label is
   * still useful for `role`); everything else (projectRoot sandbox for
   * fs/terminal, timeouts, permission policy, MCP servers) applies the same.
   */
  static async connectWebSocket(
    wsOpts: WebSocketClientTransportOptions,
    opts: ACPSessionOptions,
  ): Promise<ACPSession> {
    const transport = new WebSocketClientTransport(wsOpts);
    return ACPSession.attach(opts, transport, `failed to connect to ${wsOpts.url}`);
  }

  /**
   * Connect using a caller-supplied transport. Lets advanced callers plug
   * in their own wire (SDK streams, in-process pipes, test doubles).
   */
  static async connect(
    transport: ACPClientTransport,
    opts: ACPSessionOptions,
  ): Promise<ACPSession> {
    return ACPSession.attach(opts, transport, 'failed to connect transport');
  }

  /** Shared connect path: start the transport, install dispatch, handshake. */
  private static async attach(
    opts: ACPSessionOptions,
    transport: ACPClientTransport,
    spawnErrLabel: string,
  ): Promise<ACPSession> {
    try {
      await transport.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ACPSessionError('spawn_failed', `${spawnErrLabel}: ${msg}`, err);
    }

    const session = new ACPSession(opts, transport);
    session.transportOff = transport.onMessage((msg) => session.handleMessage(msg));
    transport.onClose?.((reason) => {
      if (!session.closed) rejectPendingRequests(session.pending, reason);
      void session.close();
    });

    try {
      await session.initialize();
    } catch (err) {
      session.transportOff?.();
      session.transportOff = null;
      try {
        transport.stop();
        /* v8 ignore next 3 - defensive catch around stop */
      } catch {
        // best effort
      }
      throw err;
    }
    return session;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Initialization
  // ──────────────────────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    const id = this.allocId();
    const result = await this.sendRequest(id, 'initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: 'wrongstack', title: 'WrongStack', version: ACP_PACKAGE_VERSION },
    });
    if (isJsonRpcError(result)) {
      throw new ACPSessionError('init_failed', `initialize failed: ${result.message}`, result);
    }
    if (
      typeof result !== 'object' ||
      result === null ||
      typeof (result as { protocolVersion?: unknown }).protocolVersion !== 'number'
    ) {
      throw new ACPSessionError('protocol_error', 'initialize returned no protocolVersion');
    }
    const r = result as {
      protocolVersion: number;
      agentCapabilities?: AgentCapabilities;
      agentInfo?: { name: string; title?: string | undefined; version: string };
      authMethods?: AuthMethod[];
    };
    if (r.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new ACPSessionError(
        'unsupported_capability',
        `agent requires protocolVersion=${r.protocolVersion}, client supports up to ${ACP_PROTOCOL_VERSION}`,
      );
    }
    this.negotiatedVersion = r.protocolVersion;
    this.agentCapabilities = r.agentCapabilities ?? {};
    const meta = (result as { _meta?: { steering?: { supported?: unknown } } })._meta;
    this.steeringSupported = meta?.steering?.supported === true;
    this.agentInfo = r.agentInfo ?? null;
    this.authMethods = r.authMethods ?? [];
    this.state = 'ready';
  }

  // ──────────────────────────────────────────────────────────────────────
  // Authentication
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Authenticate with the agent using one of the advertised auth methods.
   * Call this AFTER start() and BEFORE any session/new call.
   */
  async authenticate(methodId: string): Promise<void> {
    return delegateAuthenticate(this.acpSessionAuthHost(), methodId);
  }

  /**
   * Log out from the current authenticated session.
   * Only callable if the agent advertises `auth.logout` capability.
   */
  async logout(): Promise<void> {
    return delegateLogout(this.acpSessionAuthHost());
  }

  // ──────────────────────────────────────────────────────────────────────
  // Session management delegation
  // ──────────────────────────────────────────────────────────────────────

  private opContext(): ACPSessionOpContext {
    const self = this;
    return {
      get closed() {
        return self.closed;
      },
      get sessionId() {
        return self.sessionId;
      },
      agentCapabilities: this.agentCapabilities,
      opts: this.opts,
      allocId: () => this.allocId(),
      sendRequest: (id, method, params, timeoutMs) =>
        this.sendRequest(id, method, params, timeoutMs),
      setSessionId: (id) => {
        this.sessionId = id;
      },
      resetScratch: () => this.resetScratch(),
      closeSession: () => this.closeSession(),
    };
  }

  /** Start (or, with `resumeSessionId`, resume) the agent session now, not at the first prompt. */
  async openSession(): Promise<{ sessionId: SessionId; resumed: boolean }> {
    return executeOpenSession(this.opContext(), () => this.createSessionWithAuth());
  }

  async loadSession(sessionId: SessionId, mcpServers?: McpServer[], cwd?: string): Promise<void> {
    return executeLoadSession(this.opContext(), sessionId, mcpServers, cwd);
  }

  async resumeSession(sessionId: SessionId, mcpServers?: McpServer[], cwd?: string): Promise<void> {
    return executeResumeSession(this.opContext(), sessionId, mcpServers, cwd);
  }

  async listSessions(
    cursor?: string,
    cwd?: string,
  ): Promise<{ sessions: SessionInfo[]; nextCursor?: string | undefined }> {
    return executeListSessions(this.opContext(), cursor, cwd);
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    return executeDeleteSession(this.opContext(), sessionId);
  }

  async forkSession(
    sourceSessionId: SessionId,
    cwd?: string,
    mcpServers?: McpServer[],
  ): Promise<SessionId> {
    return executeForkSession(this.opContext(), sourceSessionId, cwd, mcpServers);
  }

  async setMode(sessionId: SessionId, modeId: string): Promise<void> {
    return executeSetMode(this.opContext(), sessionId, modeId);
  }

  async setConfigOption(sessionId: SessionId, configId: string, value: string): Promise<void> {
    return executeSetConfigOption(this.opContext(), sessionId, configId, value);
  }

  async listProviders(): Promise<{ providers: unknown[]; currentProviderId: string | null }> {
    return executeListProviders(this.opContext());
  }

  async mcpMessage(connectionId: string, message: Record<string, unknown>): Promise<unknown> {
    return executeMcpMessage(this.opContext(), connectionId, message);
  }

  async setProvider(providerId: string, config?: Record<string, unknown>): Promise<void> {
    return executeSetProvider(this.opContext(), providerId, config);
  }

  async disableProvider(): Promise<void> {
    return executeDisableProvider(this.opContext());
  }

  /** Whether {@link steer} can reach the agent. */
  canSteer(): boolean {
    return this.steeringSupported;
  }

  /** Inject a message into the agent's running turn. */
  async steer(text: string): Promise<AcpSteerOutcome> {
    return executeSteer(this.opContext(), this.steeringSupported, text);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Prompt
  // ──────────────────────────────────────────────────────────────────────

  async prompt(
    blocks: ContentBlock[],
    signal: AbortSignal,
    onProgress?: ACPProgressHandler,
  ): Promise<ACPSessionRunResult> {
    return promptFromHost(this.acpSessionPromptHost(), blocks, signal, onProgress);
  }

  /**
   * Best-effort cancel for a session the server confirmed after we already
   * stopped waiting (the abort-during-creation race). `session/cancel` is a
   * JSON-RPC notification — the server sends no response, so this is a bare
   * transport send bounded by a timer rather than sendRequest, whose
   * pending-tracking would just expire waiting for a reply that never
   * comes. A failure or timeout is surfaced on the warn channel instead of
   * being silently swallowed.
   */
  private cancelLateSession(createPromise: Promise<SessionId>): void {
    cancelLateAcpSession(this.transport, createPromise);
  }

  private async closeSession(graceMs = 10_000): Promise<void> {
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.sessionId = null;

    if (this.agentCapabilities.sessionCapabilities?.close) {
      const id = this.allocId();
      try {
        await this.sendRequest(id, 'session/close', { sessionId: sid }, graceMs);
        /* v8 ignore next 3 - best-effort close request */
      } catch {
        // Best-effort
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Lifecycle — close
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Close the session and stop the agent. `graceMs` bounds how long the
   * agent may take to answer `session/close` before it is stopped anyway —
   * shutdown passes a short one so a slow answer cannot outlive the process.
   */
  async close(opts: { graceMs?: number } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    this.callbackAbort.abort();
    this.promptCallbackAbort?.abort();
    this.promptCallbackAbort = null;
    this.terminalServer.dispose();

    if (this.sessionId && this.agentCapabilities.sessionCapabilities?.close) {
      try {
        await this.closeSession(opts.graceMs);
        /* v8 ignore next 3 - best-effort close on teardown */
      } catch {
        // best-effort
      }
    }

    rejectPendingRequests(this.pending);
    this.transportOff?.();
    this.transportOff = null;
    try {
      this.transport.stop();
    } catch {
      // best effort
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Wire layer
  // ────────────────────────────────────────────────────────────────────

  private allocId(): number {
    let candidate = Number.isSafeInteger(this.nextId) && this.nextId >= 1 ? this.nextId : 1;
    // Probe at most pending.size + 1 distinct ids: among that many candidates
    // at least one cannot be occupied by the current pending set. This keeps
    // ids precise after MAX_SAFE_INTEGER and avoids overwriting a long-running
    // request that still owns a low id after rollover.
    for (let probe = 0; probe <= this.pending.size; probe++) {
      this.nextId = candidate >= Number.MAX_SAFE_INTEGER ? 1 : candidate + 1;
      if (!this.pending.has(candidate)) return candidate;
      candidate = this.nextId;
    }
    throw new ACPSessionError('protocol_error', 'no JSON-RPC request id is available');
  }

  private async sendRequest(
    id: number,
    method: string,
    params: unknown,
    timeoutMs?: number,
    idle = false,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const effectiveTimeout = timeoutMs ?? this.timeoutMs;
      // `idle`: the clock restarts whenever the agent is heard from
      // (touchIdleRequests), so it measures silence, not the request's length.
      const expire = (): void => {
        // The agent is waiting on us (a permission decision, a file or terminal
        // call), so its silence is ours: keep the turn alive until we answer.
        if (idle && this.callbacksInFlight > 0) {
          entry.timeoutHandle = setTimeout(expire, effectiveTimeout);
          return;
        }
        this.pending.delete(id);
        reject(
          idle
            ? new ACPSessionError(
                'stalled',
                `${method}: no activity from the agent for ${Math.round(effectiveTimeout / 1000)}s`,
              )
            : new ACPSessionError(
                'protocol_error',
                `${method} timed out after ${effectiveTimeout}ms`,
              ),
        );
      };
      const entry: PendingRequest = {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timeoutMs: effectiveTimeout,
        timeoutHandle: setTimeout(expire, effectiveTimeout),
      };
      if (idle) {
        entry.rearm = () => {
          clearTimeout(entry.timeoutHandle);
          entry.timeoutHandle = setTimeout(expire, effectiveTimeout);
        };
      }
      this.pending.set(id, entry);
      this.transport
        .send({ jsonrpc: '2.0', id, method, params } as never as ACPMessage)
        .catch((err) => {
          clearTimeout(entry.timeoutHandle);
          this.pending.delete(id);
          const msg = err instanceof Error ? err.message : String(err);
          reject(new ACPSessionError('protocol_error', `send ${method} failed: ${msg}`, err));
        });
    });
  }

  /**
   * `session/new`, then one authenticate+retry if the agent demands login.
   * Logged-in CLIs succeed on the first call even when they advertise
   * `authMethods`; we do not pop OAuth on every spawn.
   */
  private async createSessionWithAuth(): Promise<SessionId> {
    return delegateCreateSessionWithAuth(this.acpSessionAuthHost());
  }

  /**
   * Pick a non-terminal auth method and run `authenticate`. Terminal-only
   * agents need an out-of-band login CLI (registry AUTHENTICATION.md) —
   * we refuse rather than hang a TUI inside the JSON-RPC child.
   */
  private async ensureAuthenticated(): Promise<void> {
    return delegateEnsureAuthenticated(this.acpSessionAuthHost());
  }

  private sendResult(id: string | number, result: unknown): Promise<void> {
    return this.transport.send({ jsonrpc: '2.0', id, result } as never as ACPMessage);
  }

  private sendErrorResponse(id: string | number, code: number, message: string): Promise<void> {
    return this.transport.send({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    } as never as ACPMessage);
  }

  private responseSender(): ACPResponseSender {
    return responseSenderFromHost.call(this.acpSessionMessagesHost());
  }

  private callbackOptions(): ACPCallbackOptions {
    return callbackOptionsFromHost.call(this.acpSessionMessagesHost());
  }

  private handleMessage(msg: ACPMessage): void {
    handleMessageFromHost.call(this.acpSessionMessagesHost(), msg);
  }

  private emitProgress(event: ACPProgressEvent): void {
    emitProgressFromHost.call(this.acpSessionMessagesHost(), event);
  }

  private progressHandler: ACPProgressHandler | null = null;
  /** Agent→client requests (permission, fs, terminal) still being answered. */
  private callbacksInFlight = 0;
  private scratch: ACPSessionScratch = createSessionScratch();

  private resetScratch(): void {
    this.scratch = createSessionScratch();
  }

  private acpSessionAuthHost(): AcpSessionAuthHost {
    const self = this;
    return {
      get state() {
        return self.state;
      },
      set state(value) {
        self.state = value;
      },
      get authMethods() {
        return self.authMethods;
      },
      allocId: (...args) => this.allocId(...args),
      sendRequest: (...args) => this.sendRequest(...args),
      get agentCapabilities() {
        return self.agentCapabilities;
      },
      opContext: (...args) => this.opContext(...args),
      ensureAuthenticated: (...args) => this.ensureAuthenticated(...args),
      authenticate: (...args) => this.authenticate(...args),
      opts: this.opts,
    };
  }

  private acpSessionMessagesHost(): AcpSessionMessagesHost {
    // Preserve the owner's instance and check each member against the helper contract.
    void (this.sendResult satisfies AcpSessionMessagesHost['sendResult']);
    void (this.sendErrorResponse satisfies AcpSessionMessagesHost['sendErrorResponse']);
    void (this.promptCallbackAbort satisfies AcpSessionMessagesHost['promptCallbackAbort']);
    void (this.callbackAbort satisfies AcpSessionMessagesHost['callbackAbort']);
    void (this.pending satisfies AcpSessionMessagesHost['pending']);
    void (this.sessionId satisfies AcpSessionMessagesHost['sessionId']);
    void (this.scratch satisfies AcpSessionMessagesHost['scratch']);
    void (this.emitProgress satisfies AcpSessionMessagesHost['emitProgress']);
    void (this.permissionPolicy satisfies AcpSessionMessagesHost['permissionPolicy']);
    void (this.responseSender satisfies AcpSessionMessagesHost['responseSender']);
    void (this.callbackOptions satisfies AcpSessionMessagesHost['callbackOptions']);
    void (this.fileServer satisfies AcpSessionMessagesHost['fileServer']);
    void (this.terminalServer satisfies AcpSessionMessagesHost['terminalServer']);
    void (this.progressHandler satisfies AcpSessionMessagesHost['progressHandler']);
    void (this.callbacksInFlight satisfies AcpSessionMessagesHost['callbacksInFlight']);
    return this as unknown as AcpSessionMessagesHost;
  }

  private acpSessionPromptHost(): AcpSessionPromptHost {
    // Check the complete helper contract while preserving the owner's identity and receivers.
    void ({
      closed: this.closed,
      state: this.state,
      promptCallbackAbort: this.promptCallbackAbort,
      agentCapabilities: this.agentCapabilities,
      sessionId: this.sessionId,
      transport: this.transport,
      createSessionWithAuth: this.createSessionWithAuth,
      cancelLateSession: this.cancelLateSession,
      resetScratch: this.resetScratch,
      progressHandler: this.progressHandler,
      allocId: this.allocId,
      sendRequest: this.sendRequest,
      promptIdleTimeoutMs: this.promptIdleTimeoutMs,
      scratch: this.scratch,
    } satisfies AcpSessionPromptHost);
    return this as unknown as AcpSessionPromptHost;
  }
}
