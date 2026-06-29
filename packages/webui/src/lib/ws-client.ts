import type { WSClientMessage, WSCompletionRequest, WSServerMessage } from '../types';
import { streamCoalescer } from './stream-coalescer';
import {
  buildClearModelsMessage,
  buildProviderUpdateMessage,
  buildUndoClearMessage,
} from './ws-client-helpers';
import {
  type EventHandler,
  type PendingConfirm,
  type WsStatus,
  getTokenFromWsUrl,
  getTokenFromPageUrl,
  defaultWsUrl,
  httpOriginForAuth,
  stripTokenFromAddressBar,
  stripTokenFromUrl,
} from './ws-client-utils';

// Re-export types for backward compat
export type { WsStatus };

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

export class WrongStackWebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private shouldReconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private messageQueue: WSClientMessage[] = [];
  // Cap on the offline-queue depth. Past this, send() drops the OLDEST
  // queued message before appending the new one (FIFO drop). Bounds
  // memory under long disconnects and prevents stale commands from
  // flooding the server on reconnect -- a 50k-deep queue of stale
  // user_messages re-firing on next open would just confuse the model
  // and waste its context window. 1000 is a generous budget for a
  // genuine reconnect window (typical reconnect <10s; <50 msg/s).
  private static readonly MAX_QUEUED_MESSAGES = 1000;
  private pendingConfirms: Map<string, PendingConfirm> = new Map();
  private sessionId: string | null = null;
  /** Stored last close reason / error message so the UI can show "what
   *  went wrong" while reconnecting instead of a generic spinner. */
  private lastErrorText: string | undefined;
  private statusListeners = new Set<(s: WsStatus) => void>();
  private currentStatus: WsStatus = { state: 'connecting' };

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

  private withSession<T extends Record<string, unknown>>(payload: T): T & { sessionId?: string } {
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
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'ws_client.ws_auth_failed',
          status: res.status,
          timestamp: new Date().toISOString(),
        }));
      } else {
        if (wsUrlCanUseAuthCookie(this.url)) {
          this.url = stripTokenFromUrl(this.url);
        }
        stripTokenFromAddressBar();
      }
    } catch (err) {
      // Network failure on the auth bootstrap may still work for loopback or
      // explicit public-WS URL flows. Log it and let the handshake policy decide.
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'ws_client.ws_auth_error',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }));
    }
  }

  async connect(): Promise<void> {
    // Bootstrap the HttpOnly auth cookie before the first connect.
    // After this resolves, the browser sends `Cookie: ws_token=…` on
    // the WS upgrade automatically, so we can drop the `?token=` from
    // the URL on subsequent reconnects. Idempotent — the cookie is
    // refreshed only when absent.
    await this.ensureAuthCookie();

    return new Promise((resolve, reject) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      this.setStatus({ state: 'connecting' });

      try {
        // Prefer the cookie path (C-2 fix): the browser already sends
        // `Cookie: ws_token=…` on the WS upgrade after `ensureAuthCookie`.
        // If the first-load URL carried `?token=...`, ensureAuthCookie()
        // strips it from this.url after the cookie exchange succeeds.
        this.ws = new WebSocket(this.url);
        this.ws.binaryType = 'arraybuffer';

        const connectTimeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 10000);

        // Track whether the connection was ever established so onerror and
        // onclose know whether to reject the promise or just attempt a
        // reconnect. Without this, a connection failure leaves callers
        // awaiting connect() hanging forever.
        let established = false;

        this.ws.onopen = () => {
          clearTimeout(connectTimeout);
          established = true;
          this.reconnectAttempts = 0;
          this.lastErrorText = undefined;
          this.setStatus({ state: 'open' });
          this.flushMessageQueue();
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data) as WSServerMessage;
            this.handleMessage(msg);
          } catch (err) {
            console.error(JSON.stringify({
              level: 'error',
              event: 'ws_client.message_parse_failed',
              message: err instanceof Error ? err.message : String(err),
              timestamp: new Date().toISOString(),
            }));
          }
        };

        this.ws.onerror = (error) => {
          console.error(JSON.stringify({
            level: 'error',
            event: 'ws_client.error',
            message: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          }));
          // ErrorEvent in browsers is intentionally opaque — Chrome won't
          // expose the underlying reason for security. We stash a generic
          // hint so the UI has something to display.
          this.lastErrorText = 'Connection error (see browser devtools)';
          if (!established) {
            clearTimeout(connectTimeout);
            reject(new Error(this.lastErrorText));
          }
        };

        this.ws.onclose = (ev) => {
          if (!established) {
            clearTimeout(connectTimeout);
            const reason = ev.reason || `Closed with code ${ev.code}`;
            this.lastErrorText = reason;
            reject(new Error(reason));
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
        this.lastErrorText = err instanceof Error ? err.message : String(err);
        this.setStatus({ state: 'closed', error: this.lastErrorText });
        reject(err);
      }
    });
  }

  private attemptReconnect() {
    if (!this.shouldReconnect || this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.reconnectTimer = null;
      this.setStatus({ state: 'closed', error: this.lastErrorText ?? 'Disconnected' });
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * 2 ** (this.reconnectAttempts - 1), 30000);
    const nextRetryAt = Date.now() + delay;
    this.setStatus({
      state: 'reconnecting',
      attempt: this.reconnectAttempts,
      nextRetryAt,
      lastError: this.lastErrorText,
    });

    this.reconnectTimer = setTimeout(async () => {
      if (this.shouldReconnect) {
        try {
          await this.connect();
        } catch (err) {
          console.error(JSON.stringify({
            level: 'error',
            event: 'ws_client.reconnect_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }));
        }
      }
    }, delay);
  }

  /** Force an immediate reconnect attempt, bypassing the backoff timer. */
  retryNow(): void {
    if (this.currentStatus.state === 'open') return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    void this.connect().catch((err) => console.warn(JSON.stringify({
      level: 'warn',
      event: 'ws_client.reconnect_failed',
      message: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    })));
  }

  private flushMessageQueue() {
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift();
      if (msg) this.send(msg);
    }
  }

  private handleMessage(msg: WSServerMessage) {
    if (msg.type === 'tool.confirm_needed') {
      const payload = msg.payload as never as {
        id: string;
        toolName: string;
        input: unknown;
        suggestedPattern: string;
        resolve: (d: 'yes' | 'no' | 'always' | 'deny') => void;
      };

      this.pendingConfirms.set(payload.id, {
        resolve: payload.resolve,
      });

      const msgForHandler = {
        ...msg,
        payload: {
          ...payload,
          resolve: () => {},
        },
      };

      this.emit(msgForHandler as WSServerMessage);
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
      const payload = msg.payload as { sessionId: string };
      this.sessionId = payload.sessionId;
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
          console.error(JSON.stringify({
            level: 'error',
            event: 'ws_client.handler_error',
            messageType: msg.type,
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }));
        }
      }
    }
  }

  send(message: WSClientMessage) {
    if (
      message.type === 'context.clear' ||
      message.type === 'session.new' ||
      message.type === 'session.resume' ||
      message.type === 'projects.select'
    ) {
      streamCoalescer.dropAll();
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // FIFO-drop oldest when full. Keeps the queue bounded under
      // long disconnects and ensures the most recent user intent is
      // preserved (vs. a flood of stale earlier messages on reconnect).
      if (
        this.messageQueue.length >= WrongStackWebSocketClient.MAX_QUEUED_MESSAGES
      ) {
        const dropped = this.messageQueue.shift();
        if (dropped) {
          console.warn(JSON.stringify({
            level: 'warn',
            event: 'ws_client.message_queue_full',
            cap: WrongStackWebSocketClient.MAX_QUEUED_MESSAGES,
            droppedType: dropped.type,
            timestamp: new Date().toISOString(),
          }));
        }
      }
      this.messageQueue.push(message);
    }
  }

  on(eventType: string, handler: EventHandler): () => void {
    let handlers = this.handlers.get(eventType);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(eventType, handlers);
    }
    handlers.add(handler);
    return () => handlers?.delete(handler);
  }

  off(eventType: string, handler: EventHandler) {
    this.handlers.get(eventType)?.delete(handler);
  }

  sendMessage(content: string, imageBase64?: string): string {
    const id = `msg_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    this.send({
      type: 'user_message',
      payload: this.withSession({
        id,
        content,
        timestamp: Date.now(),
        ...(imageBase64 ? { imageBase64 } : {}),
      }),
    });
    return id;
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
    const pending = this.pendingConfirms.get(id);
    if (pending) {
      pending.resolve(decision);
      this.pendingConfirms.delete(id);
    }
    this.send({
      type: 'tool.confirm_result',
      payload: this.withSession({ id, decision }),
    });
  }

  switchModel(provider: string, model: string) {
    this.send({
      type: 'model.switch',
      payload: { provider, model },
    });
  }

  newSession() {
    this.send({ type: 'session.new', payload: this.withSession({}) });
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

  addProvider(id: string, family: string, baseUrl?: string | undefined, apiKey?: string) {
    this.send({ type: 'provider.add', payload: { id, family, baseUrl, apiKey } });
  }

  removeProvider(providerId: string) {
    this.send({ type: 'provider.remove', payload: { providerId } });
  }

  // ---- Subscription OAuth login (ChatGPT / Claude / Copilot) ----

  /** Begin a subscription sign-in; progress arrives as `auth.oauth.status`. */
  startOAuth(kind: 'chatgpt' | 'claude' | 'copilot') {
    this.send({ type: 'auth.oauth.start', payload: { kind } });
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

  /** Update a saved provider's wire config (family / baseUrl / envVars / models). */
  updateProvider(payload: {
    id: string;
    family?: string | undefined;
    baseUrl?: string | undefined;
    envVars?: string[] | undefined;
    models?: string[] | undefined;
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

  debugContext() {
    this.send({ type: 'context.debug', payload: this.withSession({}) });
  }

  listContextModes() {
    this.send({ type: 'context.modes.list', payload: this.withSession({}) });
  }

  switchContextMode(id: string) {
    this.send({ type: 'context.mode.switch', payload: this.withSession({ id }) });
  }

  createContextMode(mode: { id: string; name: string; description: string; thresholds: { warn: number; soft: number; hard: number }; preserveK: number; eliseThreshold: number }) {
    this.send({ type: 'context.mode.create', payload: this.withSession(mode) });
  }

  updateContextMode(id: string, patch: { name?: string | undefined; description?: string | undefined; thresholds?: { warn?: number | undefined; soft?: number | undefined; hard?: number | undefined } | undefined; preserveK?: number | undefined; eliseThreshold?: number | undefined }) {
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

  // ---- Inspect commands (mirror TUI/CLI's /tools /memory /skill /diag /stats) ----

  listTools() {
    this.send({ type: 'tools.list' });
  }

  listMemory() {
    this.send({ type: 'memory.list' });
  }

  remember(text: string, scope?: 'project-agents' | 'project-memory' | 'user-memory') {
    this.send({ type: 'memory.remember', payload: { text, scope } });
  }

  forget(text: string, scope?: 'project-agents' | 'project-memory' | 'user-memory') {
    this.send({ type: 'memory.forget', payload: { text, scope } });
  }

  // ── MCP server management ─────────────────────────────────────────────────────
  listMcpServers() {
    this.send({ type: 'mcp.list' });
  }

  addMcpServer(config: { name: string; transport: string; description?: string; enabled?: boolean; command?: string; args?: string[]; env?: Record<string, string>; allowedTools?: string[]; url?: string; headers?: Record<string, string>; lazy?: boolean }) {
    this.send({ type: 'mcp.add', payload: config });
  }

  removeMcpServer(name: string) {
    this.send({ type: 'mcp.remove', payload: { name } });
  }

  updateMcpServer(config: { name: string; transport?: string; description?: string; enabled?: boolean; command?: string; args?: string[]; env?: Record<string, string>; allowedTools?: string[]; url?: string; headers?: Record<string, string>; lazy?: boolean }) {
    this.send({ type: 'mcp.update', payload: config });
  }

  wakeMcpServer(name: string) {
    this.send({ type: 'mcp.wake', payload: { name } });
  }

  sleepMcpServer(name: string) {
    this.send({ type: 'mcp.sleep', payload: { name } });
  }

  discoverMcpServer(name: string) {
    this.send({ type: 'mcp.discover', payload: { name } });
  }

  enableMcpServer(name: string) {
    this.send({ type: 'mcp.enable', payload: { name } });
  }

  disableMcpServer(name: string) {
    this.send({ type: 'mcp.disable', payload: { name } });
  }

  restartMcpServer(name: string) {
    this.send({ type: 'mcp.restart', payload: { name } });
  }

  listSkills() {
    this.send({ type: 'skills.list' });
  }

  getSkillContent(name: string, source: string) {
    this.send({ type: 'skills.content', payload: { name, source } });
  }

  installSkill(ref: string, global?: boolean) {
    this.send({ type: 'skills.install', payload: { ref, global } });
  }

  uninstallSkill(name: string, global?: boolean) {
    this.send({ type: 'skills.uninstall', payload: { name, global } });
  }

  checkForUpdates(name?: string, global?: boolean) {
    this.send({ type: 'skills.update', payload: { name, global } });
  }

  createSkill(name: string, description: string, scope: 'project' | 'global') {
    this.send({ type: 'skills.create', payload: { name, description, scope } });
  }

  editSkill(name: string, body: string) {
    this.send({ type: 'skills.edit', payload: { name, body } });
  }

  exportAllSkills() {
    this.send({ type: 'skills.export' });
  }

  getDiag() {
    this.send({ type: 'diag.get', payload: this.withSession({}) });
  }

  getStats() {
    this.send({ type: 'stats.get', payload: this.withSession({}) });
  }

  saveSession() {
    this.send({ type: 'session.save', payload: this.withSession({}) });
  }

  resumeSessionById(id: string) {
    this.send({ type: 'session.resume', payload: this.withSession({ id }) });
  }

  listModes() {
    this.send({ type: 'modes.list' });
  }

  switchMode(id: string) {
    this.send({ type: 'mode.switch', payload: { id } });
  }

  listFiles(query?: string, limit?: number, path?: string) {
    this.send({ type: 'files.list', payload: { query, limit, path } });
  }

  requestCompletion(payload: WSCompletionRequest['payload']) {
    this.send({ type: 'completion.request', payload });
  }

  getTodos() {
    this.send({ type: 'todos.get', payload: this.withSession({}) });
  }

  clearTodos() {
    this.send({ type: 'todos.clear', payload: this.withSession({}) });
  }

  removeTodo(idOrIndex: string | number) {
    const payload = typeof idOrIndex === 'number'
      ? { index: idOrIndex }
      : { id: idOrIndex };
    this.send({ type: 'todos.remove', payload: this.withSession(payload) });
  }

  updateTodoStatus(id: string, status: 'pending' | 'in_progress' | 'completed') {
    this.send({ type: 'todo.update', payload: this.withSession({ id, status }) });
  }

  getTasks() {
    this.send({ type: 'tasks.get', payload: this.withSession({}) });
  }

  updateTaskStatus(id: string, status: string) {
    this.send({ type: 'task.update', payload: this.withSession({ id, status }) });
  }

  getPlan() {
    this.send({ type: 'plan.get', payload: this.withSession({}) });
  }

  updatePlanItem(target: string, status: 'open' | 'in_progress' | 'done') {
    this.send({ type: 'plan.item.update', payload: this.withSession({ target, status }) });
  }

  listSessions(limit = 50) {
    this.send({ type: 'sessions.list', payload: this.withSession({ limit }) });
  }

  deleteSession(id: string) {
    this.send({ type: 'session.delete', payload: { id } });
  }

  listProjects() {
    this.send({ type: 'projects.list' });
  }

  addProject(root: string, name?: string | undefined) {
    this.send({ type: 'projects.add', payload: { root, name } });
  }

  selectProject(root: string, name?: string | undefined) {
    this.send({ type: 'projects.select', payload: { root, name } });
  }

  setWorkingDir(path: string) {
    this.send({ type: 'working_dir.set', payload: { path } });
  }

  resumeSession(sessionId: string) {
    this.send({
      type: 'session.resume',
      payload: this.withSession({ id: sessionId }),
    });
  }

  ping() {
    this.send({ type: 'ping' });
  }

  refineModel(text: string) {
    this.send({ type: 'model.refine', payload: { text } });
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Drop anything queued while disconnected. A subsequent connect()
    // starts fresh -- re-firing stale user_messages or session.commands
    // from before the disconnect would be confusing at best and buggy
    // at worst (e.g. an old 'session.new' overriding the user's new one).
    this.messageQueue.length = 0;
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

let client: WrongStackWebSocketClient | null = null;

/**
 * Default WS URL derived from the page's host.
 *
 * Subtle gotcha on Windows: when the page is loaded from `http://localhost:3456`,
 * the browser resolves `localhost` *itself* and on Windows it tries IPv6 `[::1]`
 * before IPv4 `127.0.0.1`. If the backend listens only on `127.0.0.1`, every
 * connection attempt to `ws://localhost:3457` first hits the IPv6 socket
 * (refused) and then either gives up or flaps — symptom: "ws disconnect hep".
 *
 * Fix: when the page is on a loopback host (`localhost` / `127.0.0.1` / `::1`),
 * force the WS URL to use the literal IPv4 loopback address. That bypasses the
 * DNS dance entirely. For any other hostname (LAN IP, custom WS_HOST override)
 * we keep the page's hostname so things still "just work".
 *
 * The WS port is NOT hardcoded: the HTTP server stamps the live port into the
 * served HTML as `<meta name="wrongstack-ws-port">` (see http-server.ts), so
 * several WebUI instances can run on different PORT/WS_PORT pairs at once. We
 * fall back to 3457 only when the tag is absent (e.g. the vite dev server).
 */
export function getWSClient(url?: string): WrongStackWebSocketClient {
  if (!client) {
    client = new WrongStackWebSocketClient(url);
  }
  return client;
}
