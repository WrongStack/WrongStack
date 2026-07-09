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
  /** HTTP frontend port. Prefer `httpPort`; `port` is kept for compatibility. */
  port?: number | undefined;
  /** HTTP frontend port. */
  httpPort?: number | undefined;
  webuiPort?: number | undefined;
  /** WebSocket backend port. */
  wsPort?: number | undefined;
  /** Host/interface to bind. */
  wsHost?: string | undefined;
  /** Fixed access token/password. Defaults to WEBUI_TOKEN or random per process. */
  accessToken?: string | undefined;
  /** Browser-facing HTTP URL, used in startup output and instance registry. */
  publicUrl?: string | undefined;
  /** Browser-facing WebSocket URL, injected into the frontend for tunnels/proxies. */
  publicWsUrl?: string | undefined;
  /** Force token/password protection even on loopback binds. */
  requireToken?: boolean | undefined;
  /**
   * Path to the directory containing the built WebUI frontend assets
   * (the `dist` directory of `@wrongstack/webui`). When omitted, the
   * server tries to resolve the frontend package from its own module
   * location; callers that embed the server (e.g. the desktop app) should
   * pass an explicit path for deterministic resolution.
   */
  distDir?: string | undefined;
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
  /** Unique per-connection id — used to key per-connection state (e.g. the
   *  rate-limit bucket) so distinct browser tabs that share the same
   *  `sessionId` do not collide, and so the entry is reliably removable on
   *  close (`String(ws)` is `"[object Object]"` for every socket). */
  connId: string;
}

// ── Cross-package shared types (PR #018b) ──────────────────────────────
// These types were previously defined in packages/webui/src/types.ts (the
// frontend) but used by both server handlers and the frontend. They live
// in the server's types now because the server owns the WS protocol —
// the frontend imports them from @wrongstack/webui-server (see webui's
// tsconfig.json alias). This avoids the previous design where the server
// depended on the frontend (cross-package inversion).

/** Role a client declares on `collab.join`. Forward-compatible: 'controller' is
 *  the future Phase 3 capability; Phase 1 only honors 'observer'. */
export type CollabRole = 'observer' | 'annotator' | 'controller';

/** Sent on connect and every 2s while at least one participant is watching. */
export interface WSCollabState {
  type: 'collab.state';
  payload: {
    sessionId: string;
    participants: Array<{
      participantId: string;
      role: CollabRole;
      joinedAt: string;
    }>;
  };
}

/** One worktree lane in the swim-lane / DAG view. */
export interface WorktreeHandleView {
  handleId: string;
  ownerId: string;
  ownerLabel: string;
  /** Absolute checkout path (for open-in-terminal / remove). */
  dir?: string | undefined;
  branch: string;
  baseBranch: string;
  status: 'allocating' | 'active' | 'committing' | 'merging' | 'merged' | 'needs-review' | 'failed';
  insertions: number;
  deletions: number;
  files: number;
  conflictFiles?: string[] | undefined;
  allocatedAt: number;
  lastEventAt: number;
  recentActivity: Array<{ kind: string; text: string; at: number }>;
}

/** One orphaned git artifact left by a previous/crashed run. */
export interface WorktreeOrphanView {
  /** Absolute checkout path (omitted for a branch-only orphan). */
  dir?: string | undefined;
  /** Branch name (`wstack/ap/*`), when known. */
  branch?: string | undefined;
  kind: 'worktree' | 'branch';
}
