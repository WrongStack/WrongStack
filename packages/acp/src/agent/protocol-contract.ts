/**
 * Public contracts and wire-boundary helpers for the ACP v1 protocol handler.
 * Keeping these declarations separate leaves the handler focused on request dispatch.
 */

import type { ACPMessage } from '../types/acp-messages.js';
import {
  ACP_PROTOCOL_VERSION,
  type ContentBlock,
  type PermissionOption,
  type PlanEntry,
  type RequestPermissionOutcome,
  type StopReason,
  type ToolKind,
  type UsageCost,
} from '../types/acp-v1.js';
import { ACP_PACKAGE_VERSION } from '../version.js';
import type { AgentServerTransport } from './stdio-transport.js';

export type { ACPMessage, ContentBlock, RequestPermissionOutcome };
export { ACP_PROTOCOL_VERSION };

// Transport's `send` is typed `ACPMessage` which predates v1 and
// doesn't carry a `jsonrpc` field. The runtime is fine — the
// transport just `JSON.stringify`s the message — so cast at the
// boundary.
type WireMessage = {
  jsonrpc?: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};
export function toWire(msg: WireMessage): ACPMessage {
  return msg as never as ACPMessage;
}

export const WRONGSTACK_VERSION = ACP_PACKAGE_VERSION;
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
 * A tool-call permission request the agent surfaces to the client.
 */
export interface RunTurnPermissionRequest {
  toolCall: { toolCallId: string; title: string; kind?: ToolKind | undefined };
  options: PermissionOption[];
}

/** Client filesystem/terminal capabilities advertised at initialize. */
export interface ClientCapabilities {
  fs?: { readTextFile?: boolean | undefined; writeTextFile?: boolean | undefined } | undefined;
  terminal?: boolean | undefined;
}

/**
 * Client-callback API handed to `runTurn`. Lets the agent's tools call back
 * into the connected ACP client — ask for permission, and (when the client
 * advertises the capability) use the client's filesystem and terminal so the
 * editor's view (including unsaved buffers) is the source of truth.
 */
export interface RunTurnApi {
  /**
   * Ask the connected ACP client to approve/reject a tool call via the
   * `session/request_permission` method. Resolves with the client's
   * outcome. Rejects if no client channel is available or the request
   * times out — the caller decides the fallback.
   */
  requestPermission(req: RunTurnPermissionRequest): Promise<RequestPermissionOutcome>;
  /** Capabilities the client advertised at initialize — gate tool wiring on these. */
  clientCapabilities: ClientCapabilities;
  /** Read a text file from the client's filesystem (`fs/read_text_file`). */
  readTextFile(params: { path: string; line?: number; limit?: number }): Promise<string>;
  /** Write a text file in the client's filesystem (`fs/write_text_file`). */
  writeTextFile(params: { path: string; content: string }): Promise<void>;
  /**
   * Run a command in the client's terminal (`terminal/create` →
   * `wait_for_exit` → `output` → `release`) and resolve with the combined
   * output and exit code.
   */
  runTerminal(params: {
    command: string;
    args?: string[] | undefined;
    cwd?: string | undefined;
  }): Promise<{ output: string; exitCode: number | null }>;
}

/**
 * The agent's per-turn work. Streams `SessionUpdate` notifications to
 * `emit` and resolves with the final stopReason. Errors thrown from
 * this iterable are converted to a `prompt_failed` JSON-RPC error.
 *
 * `api` is an optional client-callback surface (permission requests).
 * Older runTurn implementations that ignore it keep working unchanged.
 */
export type RunTurn = (
  input: RunTurnInput,
  emit: (update: unknown) => void,
  api?: RunTurnApi,
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
  /**
   * Optional source of replayable conversation history for `session/load`.
   * Returns the `session/update` payloads (user/agent message chunks) to
   * stream back to the client before the load response. Wired from
   * `makeACPServerAgentTurn(...).replay`.
   */
  replayFor?:
    | ((sessionId: string) => Array<{ sessionUpdate: string; content: unknown }>)
    | undefined;
  /**
   * Optional hook to prime the turn engine's session history on cold
   * `session/load` (server restart). Wired from `makeACPServerAgentTurn(...).seed`
   * — it re-feeds the persisted conversation into the next-created Agent so
   * the model resumes, not just the client UI.
   */
  seedFor?:
    | ((sessionId: string, history: Array<{ sessionUpdate: string; content: unknown }>) => void)
    | undefined;
  /** Release per-session agent/history resources after close, delete, or handler teardown. */
  disposeFor?: ((sessionId: string) => void) | undefined;
  /** Maximum sessions retained concurrently by one protocol handler. Default 64. */
  maxSessions?: number | undefined;
  /**
   * Optional durable session store. When set, sessions + their recorded
   * history are persisted on create/prompt and restored on `session/load`,
   * so a reconnecting client can resume after a server restart.
   * (Structural type — `ACPSessionStore` satisfies it without a value import.)
   */
  store?: SessionPersistence | undefined;
}

/** Minimal durable-store contract the handler uses (ACPSessionStore satisfies it). */
export interface SessionPersistence {
  save(
    state: SessionState,
    history?: Array<{ sessionUpdate: string; content: unknown }>,
  ): Promise<unknown>;
  load(
    sessionId: string,
  ): Promise<
    | (Partial<SessionState> & {
        history?: Array<{ sessionUpdate: string; content: unknown }> | undefined;
      })
    | null
  >;
}
