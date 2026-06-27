/**
 * ACP v1 server-side protocol handler.
 *
 * Receives JSON-RPC requests from an external ACP client (Zed, JetBrains
 * Junie, VS Code ACP extension, etc.) over stdio and answers them per the
 * v1 spec. See https://agentclientprotocol.com/protocol/v1/overview.
 *
 * Supported methods
 * ─────────────────
 *  - initialize                — handshake
 *  - authenticate              — optional, no-op when auth isn't required
 *  - session/new               — create a session
 *  - session/load              — restore a session by id
 *  - session/prompt            — run one turn, stream session/update
 *                               notifications, return stopReason
 *  - session/cancel            — notification (no response); cancels the
 *                               in-flight turn on the target session
 *  - session/set_mode          — change the active mode for a session
 *  - session/set_config_option — change a config option value
 *  - session/list              — list known sessions
 *
 * Method execution
 * ────────────────
 *  The handler is transport-agnostic; it sends responses via the
 *  `AgentServerTransport` injected at construction. The actual
 *  agent-loop work for a `session/prompt` turn is delegated to the
 *  caller-provided `runTurn` callback, which receives the prompt
 *  blocks and the per-turn AbortSignal and resolves with the final
 *  stopReason. Updates are streamed via the `emit` callback passed
 *  to `runTurn`; the handler wraps each as a `session/update`
 *  notification.
 *
 *  This separation keeps the handler unit-testable: tests can supply
 *  a fake `runTurn` that yields a canned sequence of updates, and
 *  assert on the JSON-RPC traffic the handler produces. A real
 *  production caller wires `runTurn` to a core `Agent` instance.
 *
 * Concurrency
 * ───────────
 *  Each session is single-threaded (one active turn at a time). The
 *  handler keeps a per-session AbortController so a `session/cancel`
 *  notification can stop the running turn mid-stream without tearing
 *  down the session. Multiple sessions can be active concurrently.
 */
import { ACP_PROTOCOL_VERSION, type StopReason, type ContentBlock, type PlanEntry, type UsageCost } from '../types/acp-v1.js';
import type { AgentServerTransport } from './stdio-transport.js';
import type { ACPMessage } from '../types/acp-messages.js';

// Transport's `send` is typed `ACPMessage` which predates v1 and
// doesn't carry a `jsonrpc` field. The runtime is fine — the
// transport just `JSON.stringify`s the message — so cast at the
// boundary.
type WireMessage = { jsonrpc?: '2.0'; id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };
function toWire(msg: WireMessage): ACPMessage {
  return msg as never as ACPMessage;
}

export const WRONGSTACK_VERSION = '0.274.1';
const WRONGSTACK_AUTH_METHODS = [
  {
    id: 'wrongstack-auth',
    name: 'Run wstack auth',
    description: 'Configure a WrongStack model provider in an interactive terminal.',
    type: 'terminal',
    args: ['auth'],
  },
];

/** What kinds of content the agent accepts in a prompt. */
export interface PromptCapabilities {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}

export interface AgentCapabilities {
  loadSession: boolean;
  promptCapabilities: PromptCapabilities;
}

export interface RunTurnInput {
  sessionId: string;
  /** Content blocks the client sent. */
  prompt: readonly ContentBlock[];
  /** Cancelled when the client sends `session/cancel` for this session. */
  signal: AbortSignal;
}

export interface RunTurnResult {
  stopReason: StopReason;
  /** Optional summary text the agent produced. */
  text?: string;
  plan?: PlanEntry[];
  usage?: { used: number; size: number; cost?: UsageCost | undefined };
}

/**
 * The agent's per-turn work. Streams `SessionUpdate` notifications to
 * `emit` and resolves with the final stopReason. Errors thrown from
 * this iterable are converted to a `prompt_failed` JSON-RPC error.
 */
export type RunTurn = (
  input: RunTurnInput,
  emit: (update: unknown) => void,
) => Promise<RunTurnResult>;

export interface SessionState {
  id: string;
  cwd: string;
  /** Per-turn abort signal — aborted when the session is cancelled or closed. */
  abort: AbortController;
  /** Active mode, advertised to the client in current_mode_update. */
  modeId: string;
  /** Created at, for session/list ordering. */
  createdAt: string;
  /** Last activity timestamp, for session/info_update. */
  updatedAt: string;
  /** Optional human title. */
  title?: string;
}

/** MCP-style session mode advertised in current_mode_update. */
export interface SessionMode {
  id: string;
  name: string;
  description?: string | undefined;
}

export interface SessionConfigOption {
  id: string;
  name: string;
  type: 'select' | string;
  currentValue: string;
  options: { value: string; name: string; description?: string | undefined }[];
}

export interface ProtocolHandlerOptions {
  transport: AgentServerTransport;
  /** Where the server is running; used for new sessions' default cwd. */
  defaultCwd: string;
  /** Agent's per-turn implementation. */
  runTurn: RunTurn;
  /**
   * Optional callbacks for the lifecycle events the server should
   * surface to the client. All default to no-ops.
   */
  onSessionNew?: ((state: SessionState) => void) | undefined;
  /** Static list of available modes (advertised to clients). */
  modes?: readonly SessionMode[] | undefined;
  /** Static list of config options. */
  configOptions?: readonly SessionConfigOption[] | undefined;
  /** Agent name advertised in initialize. */
  agentName?: string | undefined;
}

/** Single global mode id, sufficient for v1. */
const DEFAULT_MODE_ID = 'code';

const DEFAULT_MODES: readonly SessionMode[] = [
  {
    id: DEFAULT_MODE_ID,
    name: 'Code',
    description: 'Default agent mode for code-generation tasks.',
  },
];

export class ACPProtocolHandler {
  private readonly transport: AgentServerTransport;
  private readonly defaultCwd: string;
  private readonly runTurn: RunTurn;
  private readonly onSessionNew: (state: SessionState) => void;
  private readonly modes: readonly SessionMode[];
  private readonly configOptions: readonly SessionConfigOption[];
  private readonly agentName: string;

  private initialized = false;
  private readonly sessions = new Map<string, SessionState>();
  private nextId = 1;

  constructor(opts: ProtocolHandlerOptions) {
    this.transport = opts.transport;
    this.defaultCwd = opts.defaultCwd;
    this.runTurn = opts.runTurn;
    this.onSessionNew = opts.onSessionNew ?? (() => {});
    this.modes = opts.modes ?? DEFAULT_MODES;
    this.configOptions = opts.configOptions ?? [];
    this.agentName = opts.agentName ?? 'wrongstack';
  }

  /**
   * Process one inbound message. Returns true if this was a terminal
   * message (rare; reserved for future use by the server's own
   * shutdown signal).
   */
  async handleMessage(msg: unknown): Promise<boolean> {
    if (typeof msg !== 'object' || msg === null) return false;
    const m = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

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
    for (const [, session] of this.sessions) {
      session.abort.abort();
    }
    this.sessions.clear();
  }

  // ────────────────────────────────────────────────────────────────────
  // Requests
  // ────────────────────────────────────────────────────────────────────

  private async handleRequest(
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<boolean> {
    // The only method allowed before initialize is `initialize` itself.
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
        case 'session/new':
          return await this.handleSessionNew(id, params);
        case 'session/load':
          return await this.handleSessionLoad(id, params);
        case 'session/prompt':
          return await this.handleSessionPrompt(id, params);
        case 'session/set_mode':
          return await this.handleSetMode(id, params);
        case 'session/set_config_option':
          return await this.handleSetConfigOption(id, params);
        case 'session/list':
          return await this.handleSessionList(id);
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
    const p = (params ?? {}) as { protocolVersion?: unknown };
    const requested = typeof p.protocolVersion === 'number' ? p.protocolVersion : 1;
    if (requested !== ACP_PROTOCOL_VERSION) {
      // v1 spec: "If the client requests a different protocol version, the
      // agent SHOULD respond with an error and the version it supports."
      await this.sendError(
        id,
        -32000,
        `server speaks protocolVersion=${ACP_PROTOCOL_VERSION}, client requested ${requested}`,
      );
      return false;
    }
    this.initialized = true;
    await this.transport.send(toWire({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            image: false,
            audio: false,
            embeddedContext: true,
          },
        },
        agentInfo: {
          name: this.agentName,
          title: 'WrongStack',
          version: WRONGSTACK_VERSION,
        },
        // Static options advertised at handshake. They are also
        // re-sent on every `current_mode_update` / `config_option_update`
        // notification so late-joining clients see them.
        authMethods: WRONGSTACK_AUTH_METHODS,
        modes: this.modes,
        configOptions: this.configOptions,
      },
    }));
    return false;
  }

  private async handleAuthenticate(id: string | number, _params: unknown): Promise<boolean> {
    // WrongStack doesn't currently require auth. Per spec, a server
    // MAY respond with an unauthenticated outcome to tell the client
    // to proceed without credentials.
    await this.transport.send(toWire({
      jsonrpc: '2.0',
      id,
      result: { outcome: 'unauthenticated' },
    }));
    return false;
  }

  private async handleSessionNew(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { cwd?: unknown; mcpServers?: unknown };
    const cwd = typeof p.cwd === 'string' ? p.cwd : this.defaultCwd;
    const sessionId = `sess_${this.allocId()}`;
    const now = new Date().toISOString();
    const state: SessionState = {
      id: sessionId,
      cwd,
      abort: new AbortController(),
      modeId: DEFAULT_MODE_ID,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, state);
    this.onSessionNew(state);

    // Per spec, the server MAY emit current_mode_update /
    // config_option_update / available_commands_update notifications
    // immediately after session/new to populate the client UI. We do.
    await this.sendNotification({
      sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        modeId: this.modes[0]?.id ?? DEFAULT_MODE_ID,
      },
    });
    if (this.configOptions.length > 0) {
      await this.sendNotification({
        sessionId,
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: [...this.configOptions],
        },
      });
    }

    await this.transport.send(toWire({
      jsonrpc: '2.0',
      id,
      result: {
        sessionId,
        modes: this.modes,
        configOptions: this.configOptions,
      },
    }));
    return false;
  }

  private async handleSessionLoad(id: string | number, params: unknown): Promise<boolean> {
    // v1 spec: "If `loadSession: true` is not in the agent's
    // capabilities, the client SHOULD NOT call this method." We
    // declared loadSession: true in initialize, so we accept it.
    // We don't persist sessions across restarts yet — for now,
    // session/load is a no-op alias of session/new.
    return this.handleSessionNew(id, params);
  }

  private async handleSessionPrompt(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { sessionId?: unknown; prompt?: unknown };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
    if (!sessionId || !this.sessions.has(sessionId)) {
      await this.sendError(id, -32000, 'unknown or missing sessionId');
      return false;
    }
    if (!Array.isArray(p.prompt)) {
      await this.sendError(id, -32602, 'prompt must be an array of content blocks');
      return false;
    }
    const session = this.sessions.get(sessionId)!;

    // If the previous turn was cancelled, recreate the AbortController
    // so a stale signal doesn't cancel the new turn.
    if (session.abort.signal.aborted) {
      session.abort = new AbortController();
    }

    const turnSignal = new AbortController();
    // Forward session/cancel notifications to the turn's signal.
    const onCancel = (): void => turnSignal.abort();
    session.abort.signal.addEventListener('abort', onCancel, { once: true });

    let result: RunTurnResult;
    try {
      result = await this.runTurn(
        { sessionId, prompt: p.prompt as ContentBlock[], signal: turnSignal.signal },
        (update) => this.sendNotification({ sessionId, update }),
      );
    } catch (err) {
      session.abort.signal.removeEventListener('abort', onCancel);
      const { code, message, data } = errorToJsonRpc(err);
      await this.sendError(id, code, message, data);
      return false;
    }
    session.abort.signal.removeEventListener('abort', onCancel);
    session.updatedAt = new Date().toISOString();

    await this.transport.send(toWire({
      jsonrpc: '2.0',
      id,
      result: { stopReason: result.stopReason },
    }));
    return false;
  }

  private async handleSetMode(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { sessionId?: unknown; modeId?: unknown };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
    const modeId = typeof p.modeId === 'string' ? p.modeId : null;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || !modeId || !this.modes.some((m) => m.id === modeId)) {
      await this.sendError(id, -32602, 'invalid sessionId or modeId');
      return false;
    }
    session.modeId = modeId;
    session.updatedAt = new Date().toISOString();
    await this.sendNotification({
      sessionId,
      update: { sessionUpdate: 'current_mode_update', modeId },
    });
    await this.transport.send(toWire({ jsonrpc: '2.0', id, result: {} }));
    return false;
  }

  private async handleSetConfigOption(id: string | number, params: unknown): Promise<boolean> {
    const p = (params ?? {}) as { sessionId?: unknown; configOptionId?: unknown; value?: unknown };
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
    const optionId = typeof p.configOptionId === 'string' ? p.configOptionId : null;
    const value = typeof p.value === 'string' ? p.value : null;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const option = optionId ? this.configOptions.find((o) => o.id === optionId) : undefined;
    if (!session || !option || value === null || !option.options.some((o) => o.value === value)) {
      await this.sendError(id, -32602, 'invalid sessionId, configOptionId, or value');
      return false;
    }
    option.currentValue = value;
    session.updatedAt = new Date().toISOString();
    await this.sendNotification({
      sessionId,
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [...this.configOptions],
      },
    });
    await this.transport.send(toWire({ jsonrpc: '2.0', id, result: {} }));
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
    await this.transport.send(toWire({
      jsonrpc: '2.0',
      id,
      result: { sessions },
    }));
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
      case 'exit':
        // Client is shutting down. Best-effort: abort all sessions.
        this.close();
        return true;
      default:
        // Unknown notification — log and ignore.
        return false;
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Wire helpers
  // ────────────────────────────────────────────────────────────────────

  private async sendNotification(params: unknown): Promise<void> {
    await this.transport.send(toWire({ jsonrpc: '2.0', method: 'session/update', params }));
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

  private allocId(): number {
    return this.nextId++;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Error mapping
// ─────────────────────────────────────────────────────────────────────────

function errorToJsonRpc(err: unknown): { code: number; message: string; data?: unknown } {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown; data?: unknown };
    if (typeof e.code === 'number' && typeof e.message === 'string') {
      const result: { code: number; message: string; data?: unknown } = {
        code: e.code,
        message: e.message,
      };
      if (e.data !== undefined) result.data = e.data;
      return result;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: -32603, message };
}
