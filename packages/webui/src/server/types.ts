// Backend types for WebUI server
// These are the internal types used by the server-side code

import type { WebSocket } from 'ws';
import type {
  Agent,
  ConfigStore,
  EventBus,
  ModelsRegistry,
  SecretVault,
  SessionWriter,
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
   * the Agent, EventBus, SessionWriter, and friends so it can run an
   * eternal iteration against them, then hands the lot to the webui
   * for the human-facing surface.
   *
   * When `services` is omitted, `startWebUI` retains its existing
   * behavior (builds the defaults in-place). This keeps the standalone
   * `node dist/index.js webui` flow fully back-compatible.
   */
  services?: BackendServices | undefined;
}

export interface BackendServices {
  agent: Agent;
  events: EventBus;
  session: SessionWriter;
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
