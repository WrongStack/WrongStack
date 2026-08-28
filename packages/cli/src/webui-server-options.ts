import type { Agent } from '@wrongstack/core/agent';
import type { BrainArbiter } from '@wrongstack/core/coordination';
import type { BrainAutoRisk } from '@wrongstack/core/execution';
import type { EventBus } from '@wrongstack/core/kernel';
import type { TrustBoundary } from '@wrongstack/core/security';
import type {
  MemoryPort,
  ModelsRegistry,
  ModeStore,
  PromptLoader,
  SessionStore,
  SessionWriter,
  SkillLoader,
} from '@wrongstack/core/types';
import type { MCPRegistry } from '@wrongstack/mcp';
import type { VectorMemoryStore } from '@wrongstack/vector-memory';
import type { WebuiSessionChildOptions } from './boot/webui-session-child.js';

/**
 * CLI-shaped webui options. Distinct from the standalone
 * `WebUIOptions` exported by `@wrongstack/webui-server` (which is the
 * type `startWebUI` accepts): the CLI builds its own agent/events/
 * session/etc. up front because the same instances power the
 * eternal-autonomy loop, and just hands the webui the surfaces it
 * needs. This type used to be called `WebUIOptions` too, which
 * caused a name collision with the standalone one whenever both
 * were imported into the same module (the CLI here imports from
 * `@wrongstack/webui-server` for shared helpers, so the collision
 * was a real source of confusion when reading this file).
 */
export interface CliWebUIOptions {
  /** Policy authority for privileged WebUI actions. */
  trustBoundary?: TrustBoundary | undefined;
  agent: Agent;
  events: EventBus;
  statusTracker?: import('@wrongstack/core/coordination').ProviderModelStatusTracker | undefined;
  session: SessionWriter;
  /** HTTP port (WS shares it — single-port design). Defaults to 3456. */
  port?: number | undefined;
  /** Host/interface to bind HTTP and WS servers. Defaults to 127.0.0.1. */
  host?: string | undefined;
  /** HTTP port serving the React frontend. Defaults to 3456 (auto-advances). */
  httpPort?: number | undefined;
  /** Alternate frontend dist directory (used by the independent SimpleUI surface). */
  frontendDistDir?: string | undefined;
  /** Surface kind: 'webui' (default) or 'simpleui'. Controls port defaults and the instance registry label. */
  surface?: 'webui' | 'simpleui' | undefined;
  /** Fixed access token/password. Defaults to WEBUI_TOKEN or random per process. */
  accessToken?: string | undefined;
  /** Fail instead of auto-advancing when the requested HTTP/WS port is busy. */
  strictPort?: boolean | undefined;
  /** Internal one-session child launch metadata for the multi-session parent shell. */
  webuiSessionChild?: WebuiSessionChildOptions | undefined;
  /**
   * Live fleet concurrency + lifetime spawn budget for WebUI (issue #323).
   * Merged into `fleet.concurrency_update` broadcasts.
   */
  getFleetBudget?:
    | (() => {
        maxSpawns?: number | undefined;
        usedSpawns?: number | undefined;
        remainingSpawns?: number | undefined;
        maxConcurrent?: number | undefined;
        activeAgents?: number | undefined;
        maxSpawnsSource?: string | undefined;
        maxConcurrentSource?: string | undefined;
        effectiveSource?: string | undefined;
        checkpointMaxSpawns?: number | undefined;
        ceilingMismatch?: boolean | undefined;
      } | null)
    | undefined;
  /**
   * Stop every subagent that ONE session spawned.
   *
   * Aborting a session's run unwinds only the workers its leader is blocked
   * on; anything started with `spawn_subagent` + `assign_task` keeps running
   * because nothing asked it to stop — so a tab's Stop button silenced the
   * leader while its fleet ground on. The CLI owns the Director, so it
   * supplies the cascade. Session-scoped by contract: with four tabs live,
   * stopping one must never reach into another's fleet.
   */
  stopSessionFleet?: ((sessionId: string) => void | Promise<void>) | undefined;
  /**
   * A tab was closed: release the host-side helpers pinned to its
   * conversation (explore companion, shadow-review bookkeeping).
   *
   * NOT a fleet teardown — a background run outlives the tab that started it,
   * which is why `retireUndisplayedSessions` skips a session with a live run
   * before calling this. Absent for hosts with a single conversation.
   */
  onSessionRetired?: ((sessionId: string) => void) | undefined;
  /** Browser-facing HTTP URL, used when WebUI is exposed behind a tunnel/proxy. */
  publicUrl?: string | undefined;
  /** Browser-facing WebSocket URL injected into the frontend. */
  publicWsUrl?: string | undefined;
  /** Force token/password protection even on loopback binds. */
  requireToken?: boolean | undefined;
  /** Project root — recorded in the running-instance registry. */
  projectRoot?: string | undefined;
  /** Full app config, used for HQ client publishing settings. */
  appConfig?: import('@wrongstack/core/types').Config | undefined;
  /** Pop the browser open to the served URL once the frontend is ready. */
  open?: boolean | undefined;
  /** Read-only worker transcript snapshot used for F5/reconnect replay. */
  agentTranscripts?:
    | {
        getAllSessions(): import('@wrongstack/core/coordination').AgentVirtualSession[];
        /** Ring + on-disk transcripts, for surfaces that survive a process restart. */
        loadSessionsFromDisk(): Promise<
          import('@wrongstack/core/coordination').AgentVirtualSession[]
        >;
      }
    | undefined;
  /**
   * Fired once the WebSocket server is accepting connections. Useful for
   * callers (and tests) that must not connect before the server is ready —
   * port resolution now makes startup asynchronous, so a synchronous bind can
   * no longer be assumed.
   */
  onListening?: (info: {
    httpPort: number;
    wsPort: number;
    host: string;
    url: string;
    authToken: string;
    webuiInstanceRegistered: boolean;
  }) => void;
  modelsRegistry?: ModelsRegistry | undefined;
  globalConfigPath?: string | undefined;
  /** Resolved profile config path: ~/.wrongstack/profiles/<activeProfile>/config.json */
  profileConfigPath: string;
  /**
   * Live MCP registry — the SAME instance the agent loop and `/mcp` use. When
   * provided, the WebUI MCP settings panel can add/remove/enable/disable and
   * actually start/stop servers (not just edit config). Threaded in from the
   * CLI host (`execution.ts`), where the registry is constructed.
   */
  mcpRegistry?: MCPRegistry | undefined;
  /**
   * Subscribe to live per-iteration events from the eternal-autonomy
   * engine. When provided, the WebUI broadcasts each iteration to every
   * connected client. Observability-only — starting the loop still goes
   * through REPL/TUI or the `--eternal` flag (the WebUI has no slash
   * command dispatch surface yet).
   */
  subscribeEternalIteration?:
    | ((fn: (entry: import('@wrongstack/core/goal').JournalEntry) => void) => () => void)
    | undefined;
  /** Callback to invoke when the WebUI is shut down by a client request. */
  onExit?: (() => void) | undefined;
  /**
   * When true, HQ `run-command` control commands are allowed to route to
   * this WebUI's agent (still delivered as a steer, so the agent's own
   * permission policy applies). Mirrors the CLI's `--hq-allow-exec`. Off by
   * default — without it, HQ run-command is rejected.
   */
  hqAllowExec?: boolean | undefined;
  /**
   * Per-task agent factory (the host's director-backed `makeSubagentFactory`).
   * When present, the WebUI exposes the "New SDD Project" wizard, which runs the
   * same multi-agent fleet as `/sdd execute`. Omitted → wizard is unavailable.
   */
  sddSubagentFactory?: import('@wrongstack/core/coordination').AgentFactory | undefined;
  /** Session store — enables session.resume and session.delete from the WebUI. */
  sessionStore?: SessionStore | undefined;
  /** Host Brain arbiter (same instance bound at TOKENS.BrainArbiter). */
  brain?: BrainArbiter | undefined;
  /** Host brain settings — the SAME object /brain mutates (shared ceiling + mode). */
  brainSettings?:
    | {
        maxAutoRisk: BrainAutoRisk;
        mode?: import('@wrongstack/core/coordination').BrainEscalationMode | undefined;
        poolLabels?: string[] | undefined;
        councilLabels?: string[] | undefined;
      }
    | undefined;
  /** Live-editable Brain config owner (brain.config.get/set handlers). */
  brainRuntime?: import('@wrongstack/core/execution').BrainRuntime | undefined;
  /** Read the host's rolling brain decision log (newest last, ≤20 entries). */
  getBrainLog?:
    | (() => Array<{ at: number; kind: string; question: string; outcome: string }>)
    | undefined;
  /**
   * Absolute path to the project's sessions directory (wpaths.projectSessions).
   * Used by checkpoint/rewind handlers to locate session JSONL files. When
   * absent, falls back to the legacy <projectRoot>/.wrongstack/sessions path.
   */
  sessionsDir?: string | undefined;
  /** Atomically reserve an explicitly selected session before opening it. */
  claimSession?:
    | ((
        sessionId: string,
        target?: {
          projectSlug: string;
          projectRoot: string;
          projectName: string;
          workingDir: string;
        },
      ) => Promise<() => Promise<void>>)
    | undefined;
  /** Rebind session-scoped todo persistence before a new todo snapshot is installed. */
  onBeforeSessionTodosReplaced?:
    | ((newSessionId: string, sessionsDir: string) => void | Promise<void>)
    | undefined;
  /**
   * Called after session.resume swaps the active writer, with the new session
   * id. Hosts use this to refresh session-scoped integrations.
   */
  onSessionSwapped?:
    | ((
        newSessionId: string,
        target?: {
          projectSlug: string;
          projectRoot: string;
          projectName: string;
          workingDir: string;
        },
      ) => void | Promise<void>)
    | undefined;
  /** Memory store — enables the Memory panel + chat `/memory` (memory.list) and the structured memory.sage.* operations. */
  memoryStore?: MemoryPort | undefined;
  /**
   * Optional vector-memory store. When provided, the four
   * `/api/vector-memory/{status,search,store,store/:id}` endpoints become
   * active. When omitted, the routes respond with `{ enabled: false }` or
   * 503 — a non-CLI webui-server host stays on its existing surface with
   * zero behavior change.
   */
  getVectorMemoryStore?: (() => VectorMemoryStore | undefined) | undefined;
  /** Model cache directory for the vector-memory provider. */
  vectorMemoryModelCacheDir?: string | undefined;
  /** Skill loader — enables the SkillsPanel (skills.list). */
  skillLoader?: SkillLoader | undefined;
  /** Prompt loader — enables the prompt library (prompts.list/search/content/favorite/create). */
  promptLoader?: PromptLoader | undefined;
  /** Mode store — enables the ModePicker (modes.list, mode.switch). */
  modeStore?: ModeStore | undefined;
  /** Active agent mode id passed to the frontend via session.start. */
  modeId?: string | undefined;
  /**
   * Host callback invoked after model.switch resolves the active model's
   * context window. The CLI uses this to refresh the shared auto-compactor
   * denominator and context chip state.
   */
  onModelContextResolved?:
    | ((providerId: string, modelId: string, maxContext: number) => void)
    | undefined;
  /** When true, the frontend shows a provider/model setup screen instead of the chat. */
  needsSetup?: boolean | undefined;
  /**
   * Forward `autonomy.switch` to the CLI's real autonomy state (the same
   * setter the TUI/REPL use). Without it the switch only lands in
   * context.meta and the running loop never changes mode.
   */
  onAutonomySwitch?: ((mode: string, sessionId?: string | undefined) => void) | undefined;
  /** Forward browser YOLO changes to the host's live permission policy. */
  onYoloSwitch?: ((enabled: boolean, sessionId?: string | undefined) => void) | undefined;
  /**
   * Forward `wrongProxyEnabled` / `wrongProxyUrl` changes from the
   * browser to the runtime probe (`@wrongstack/cli/wiring/proxy-wiring`).
   * Mirrors the `onAutonomySwitch` / `onYoloSwitch` pattern: the WS
   * server stays package-agnostic and the boot site provides the
   * host-side effect.
   */
  onWrongProxyPrefsChange?: ((payload: Record<string, unknown>) => void) | undefined;
  /**
   * Pre-computed update info from the CLI's preflight version check.
   * When present, the session.start payload includes appVersion,
   * latestVersion, and updateAvailable so all surfaces (WebUI, SimpleUI)
   * can display an "update available" warning.
   */
  updateInfo?: import('./webui-server/session-start-payload.js').BootUpdateInfo | undefined;
  /** Optional kanban task dispatch hook, backed by the CLI multi-agent host. */
  onKanbanDispatch?:
    | ((
        description: string,
        opts?: {
          provider?: string | undefined;
          model?: string | undefined;
          fallbackModels?: string[] | undefined;
          fallbackProfile?: string | undefined;
          skills?: string[] | undefined;
          tools?: string[] | undefined;
          name?: string | undefined;
          allowedCapabilities?: readonly string[] | undefined;
          onDone?:
            | ((result: {
                status: 'completed' | 'failed';
                result?: string | undefined;
                error?: string | undefined;
              }) => void | Promise<void>)
            | undefined;
        },
      ) => Promise<string>)
    | undefined;
}

// ConnectedClient is defined in ./webui-server/connection-handler.ts (PR 14
// of Issue #30) — imported below alongside createConnectionHandler.
