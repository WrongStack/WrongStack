// Backend types for WebUI server
// These are the internal types used by the server-side code

import type { WebSocket } from 'ws';
import type {
  Agent,
  ConfigStore,
  EventBus,
  JournalEntry,
  ModelsRegistry,
  SecretVault,
  SessionStore,
  ToolRegistry,
} from '@wrongstack/core';

export interface WSServerMessage {
  type: string;
  payload: unknown;
}

export interface WSClientMessage {
  type: string;
  payload?: unknown | undefined;
}

export interface WebUIOptions {
  port?: number | undefined;
  webuiPort?: number | undefined;
  /**
   * Pre-built backend services. When provided, `startWebUI` skips its
   * default agent/event-bus/session/store construction and wires the
   * supplied instances into the WS message router and HTTP API
   * handlers instead.
   *
   * Intended for callers (most notably `cli/webui-server.ts`) that
   * already own the agent lifecycle — the CLI's `runWebUI` constructs
   * the Agent, EventBus, SessionStore, and friends so it can run an
   * eternal iteration against them, then hands the lot to the webui
   * for the human-facing surface.
   *
   * `session` is typed as `SessionStore` (read + write) rather than
   * the narrower `SessionWriter` because `startWebUI` needs to
   * `load()` existing session history to project the chat view, and
   * `list()` past sessions to populate the sessions dashboard. A
   * `SessionWriter`-only field would force `startWebUI` to take a
   * separate `sessionStore` for reads, which is a worse API for the
   * CLI caller (`runWebUI` already has one store, not two).
   *
   * When `services` is omitted, `startWebUI` retains its existing
   * behavior (builds the defaults in-place). This keeps the standalone
   * `node dist/index.js webui` flow fully back-compatible.
   */
  services?: BackendServices | undefined;
  /**
   * Subscribe to live per-iteration events from the eternal-autonomy
   * engine. When provided, `startWebUI` wires a WS broadcast that
   * pushes each `JournalEntry` to every connected client. Observability
   * only — starting the loop still goes through REPL/TUI or `--eternal`,
   * since the webui has no slash-command dispatch surface yet.
   *
   * The argument is a *function* the caller supplies that performs the
   * actual subscription; the returned disposer is invoked on
   * `shutdown()`. This indirection lets the caller (most commonly
   * `cli/webui-server.ts`) own the engine lifecycle and merely hand the
   * webui an observer slot.
   */
  subscribeEternalIteration?:
    | ((fn: (entry: JournalEntry) => void) => () => void)
    | undefined;
}

export interface BackendServices {
  agent: Agent;
  events: EventBus;
  session: SessionStore;
  toolRegistry: ToolRegistry;
  modelsRegistry: ModelsRegistry;
  configStore: ConfigStore;
  vault: SecretVault;
  globalConfigPath: string;
  projectRoot: string;
}

export interface ConnectedClient {
  ws: WebSocket;
  sessionId: string | null;
  connectedAt: number;
}
