/**
 * CLI embedded WebUI server — the backend behind `wrongstack --webui`.
 *
 * `runWebUI(opts)` boots a WebSocket bridge (and, when the webui package
 * is built, the static HTTP frontend) over the *same* agent/events/
 * session instances the REPL and eternal-autonomy loop use, then routes
 * browser messages through a `handleMessage` switch.
 *
 * Issue #30 (the webui-server N-PR refactor) pulled the self-contained
 * concerns out of this file into focused `webui-server/*` modules. Where
 * each concern now lives:
 *
 *   webui-server/logger-shim.ts        — console→Logger adapter (PR 1)
 *   webui-server/cost-helpers.ts       — token/usage cost math (PR 2)
 *   webui-server/context-breakdown.ts  — context-window estimation (PR 3)
 *   webui-server/provider-config.ts    — provider-config IO + the
 *                                        ProviderConfigStore facade
 *                                        (PR 4 + follow-up)
 *   webui-server/static-serve.ts       — dist discovery + HTTP bring-up (PR 6)
 *   webui-server/lifecycle.ts          — instance registry, ready banner +
 *                                        open-browser, SIGINT/SIGTERM
 *                                        graceful shutdown (PR 7)
 *   webui-server/ws-handlers/          — every `handleMessage` case, one
 *                                        topic file per group, each threaded
 *                                        through a per-group context that
 *                                        extends the small `WsCommon` base
 *                                        (PR 5 + 5b–5k):
 *       providers · brain · introspection · worklist · agent-config ·
 *       prefs · projects · context · process · sessions · connection
 *
 * `handleMessage` now only routes: each case unpacks the payload and calls
 * the matching `handleXxx(ctx, …)`. The per-group contexts are all built
 * once (before the WS connection handler is wired, so a fast client message
 * can't reach a handler before its context initializes). The file/memory/
 * mailbox/shell cases delegate to the shared `@wrongstack/webui/server`
 * handlers.
 *
 * Public surface: `runWebUI` plus the `WSServerMessage` / `WSClientMessage`
 * message shapes. Everything else is internal to the run.
 */
import * as crypto from 'node:crypto';
import { watch as fsWatch } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Agent,
  BrainArbiter,
  BrainAutoRisk,
  Context,
  EventBus,
  MemoryStore,
  ModelsRegistry,
  ModeStore,
  PromptLoader,
  ProviderConfig,
  SessionStore,
  SessionWriter,
  SkillLoader,
} from '@wrongstack/core';
import {
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  DefaultSecretScrubber,
  GlobalMailbox,
  projectHash,
  PromptUsageStore,
  resolveProjectDir,
  resolveWstackPaths,
  TOKENS,
  type TodoItem,
  watchProviderConfig,
  wstackGlobalRoot,
} from '@wrongstack/core';
import { makeProviderFromConfig } from '@wrongstack/providers';
import { toErrorMessage } from '@wrongstack/core/utils/error';
import { SkillInstaller } from '@wrongstack/core/skills';
import type { MCPRegistry } from '@wrongstack/mcp';
import { startCliHqConnection, type CliHqConnection } from './hq-publisher.js';
import {
  AutoPhaseWebSocketHandler,
  SpecsWebSocketHandler,
  SddBoardWebSocketHandler,
  SddWizardWebSocketHandler,
  buildSddWizardDeps,
  type CustomModeStore,
  createCustomModeStore,
  createEternalSubscription,
  createToolLspCompletionSource,
  findFreePort,
  resolveAuthToken,
  buildWebUIAccessUrl,
  envFlag,
  handleCompletionRequest,
  handleFilesList,
  handleFilesRead,
  handleFilesTree,
  handleFilesWrite,
  handleGitChanges,
  handleGitDiff,
  handleGitInfo,
  handleMcpAdd,
  handleMcpDisable,
  handleMcpDiscover,
  handleMcpEnable,
  handleMcpList,
  handleMcpRemove,
  handleMcpRestart,
  handleMcpSleep,
  handleMcpUpdate,
  handleMcpWake,
  handleMemoryForget,
  handleMemoryList,
  handleMemoryRemember,
  handleShellOpen,
  handleSkillsContent,
  handleSkillsCreate,
  handleSkillsEdit,
  handleSkillsExport,
  handleSkillsInstall,
  handleSkillsUninstall,
  handleSkillsUpdate,
  type SkillsContext,
  type PromptsContext,
  handlePromptsList,
  handlePromptsSearch,
  handlePromptsContent,
  handlePromptsFavorite,
  handlePromptsCreate,
  handlePromptsUsed,
  handlePromptsRecent,
  type DesignContext,
  handleDesignList,
  handleDesignMaterialize,
  handleDesignSet,
  handleDesignUse,
  handleDesignState,
  handleDesignVerify,
  verifyClient as verifyWsClient,
  WorktreeWebSocketHandler,
} from '@wrongstack/webui/server';
import { WebSocket, WebSocketServer } from 'ws';
// ── Cost computation helpers (inlined from @wrongstack/webui/server/usage-cost.ts) ──
// PR 2 of Issue #30: extracted to `./webui-server/cost-helpers.js`.
import { getCostRates } from './webui-server/cost-helpers.js';
// PR 8 of Issue #30: extracted to `./webui-server/prefs-seeding.js`.
import { createPrefsSeeding, seedConfigToMeta } from './webui-server/prefs-seeding.js';
import {
  announceWebuiReady,
  createWebuiShutdown,
  registerWebuiInstance,
  registerWebuiSignalHandlers,
} from './webui-server/lifecycle.js';
// ── Console logger adapter for AutoPhaseWebSocketHandler ──────────────────────
// AutoPhaseWebSocketHandler requires a Logger. The CLI uses console.log/error
// directly, so we adapt that to the Logger interface expected by the handler.
// PR 1 of Issue #30: extracted to `./webui-server/logger-shim.js`.
import { consoleLogger } from './webui-server/logger-shim.js';
import { createProviderConfigStore, getVault } from './webui-server/provider-config.js';
import { startStaticServe } from './webui-server/static-serve.js';
import {
  type AgentConfigContext,
  type BrainHandlerContext,
  type ConnectionContext,
  type ContextHandlerContext,
  handleAbort,
  handleAutonomySwitch,
  handleBrainAsk,
  handleBrainRisk,
  handleBrainStatus,
  handleContextClear,
  handleContextCompact,
  handleContextDebug,
  handleContextModeCreate,
  handleContextModeDelete,
  handleContextModeSwitch,
  handleContextModesList,
  handleContextModeUpdate,
  handleContextRepair,
  handleDiagGet,
  handleGoalGet,
  broadcastSaved,
  handleKeyDelete,
  handleKeySetActive,
  handleKeyUpsert,
  handleModelRefine,
  handleModelSwitch,
  handleModeSwitch,
  handleModesList,
  handleOAuthCancel,
  handleOAuthCode,
  handleOAuthStart,
  handlePing,
  handlePlanGet,
  handlePlanItemUpdate,
  handlePlanTemplateUse,
  handlePrefsGet,
  handlePrefsUpdate,
  handleProcessKill,
  handleProcessKillAll,
  handleProcessList,
  handleProjectsAdd,
  handleProjectsList,
  handleProjectsSelect,
  handleProviderAdd,
  handleProviderClearModels,
  handleProviderModels,
  handleProviderProbe,
  handleProviderRemove,
  handleProvidersList,
  handleProvidersSaved,
  handleProviderUndoClear,
  handleProviderUpdate,
  handleSessionCheckpoints,
  handleSessionDelete,
  handleSessionNew,
  handleSessionResume,
  handleSessionRewind,
  handleSessionSave,
  handleSessionsList,
  handleSkillsList,
  handleStatsGet,
  handleTasksGet,
  handleTaskUpdate,
  handleTodosClear,
  handleTodosGet,
  handleTodosRemove,
  handleTodoUpdate,
  handleToolConfirmResult,
  handleToolsList,
  handleUserMessage,
  handleWorkingDirSet,
  type IntrospectionContext,
  type MailboxContext,
  type PrefsContext,
  type ProjectsContext,
  type SessionsContext,
  type WorklistContext,
  type WsCommon,
  type WsHandlerContext,
} from './webui-server/ws-handlers/index.js';
import {
  handleMailboxAgents,
  handleMailboxClear,
  handleMailboxMessages,
  handleMailboxPurge,
} from './webui-server/ws-handlers/mailbox.js';

// Re-export types from webui for type checking
// At runtime, the actual types are resolved via workspace resolution

// WSServerMessage and WSClientMessage types (mirrors packages/webui/src/types.ts)
export interface WSServerMessage {
  type: string;
  payload: unknown;
}

export interface WSClientMessage {
  type: string;
  payload?: unknown | undefined;
}

/**
 * CLI-shaped webui options. Distinct from the standalone
 * `WebUIOptions` exported by `@wrongstack/webui/server` (which is the
 * type `startWebUI` accepts): the CLI builds its own agent/events/
 * session/etc. up front because the same instances power the
 * eternal-autonomy loop, and just hands the webui the surfaces it
 * needs. This type used to be called `WebUIOptions` too, which
 * caused a name collision with the standalone one whenever both
 * were imported into the same module (the CLI here imports from
 * `@wrongstack/webui/server` for shared helpers, so the collision
 * was a real source of confusion when reading this file).
 */
interface CliWebUIOptions {
  agent: Agent;
  events: EventBus;
  session: SessionWriter;
  /** WebSocket backend port. Defaults to 3457 (auto-advances if taken). */
  port?: number | undefined;
  /** Host/interface to bind HTTP and WS servers. Defaults to 127.0.0.1. */
  host?: string | undefined;
  /** HTTP port serving the React frontend. Defaults to 3456 (auto-advances). */
  httpPort?: number | undefined;
  /** Fixed access token/password. Defaults to WEBUI_TOKEN or random per process. */
  accessToken?: string | undefined;
  /** Browser-facing HTTP URL, used when WebUI is exposed behind a tunnel/proxy. */
  publicUrl?: string | undefined;
  /** Browser-facing WebSocket URL injected into the frontend. */
  publicWsUrl?: string | undefined;
  /** Force token/password protection even on loopback binds. */
  requireToken?: boolean | undefined;
  /** Project root — recorded in the running-instance registry. */
  projectRoot?: string | undefined;
  /** Full app config, used for HQ client publishing settings. */
  appConfig?: import('@wrongstack/core').Config | undefined;
  /** Pop the browser open to the served URL once the frontend is ready. */
  open?: boolean | undefined;
  /**
   * Fired once the WebSocket server is accepting connections. Useful for
   * callers (and tests) that must not connect before the server is ready —
   * port resolution now makes startup asynchronous, so a synchronous bind can
   * no longer be assumed.
   */
  onListening?: (info: { httpPort: number; wsPort: number; host: string; url: string }) => void;
  modelsRegistry?: ModelsRegistry | undefined;
  globalConfigPath?: string | undefined;
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
    | ((fn: (entry: import('@wrongstack/core').JournalEntry) => void) => () => void)
    | undefined;
  /** Callback to invoke when the WebUI is shut down by a client request. */
  onExit?: (() => void) | undefined;
  /**
   * Per-task agent factory (the host's director-backed `makeSubagentFactory`).
   * When present, the WebUI exposes the "New SDD Project" wizard, which runs the
   * same multi-agent fleet as `/sdd execute`. Omitted → wizard is unavailable.
   */
  sddSubagentFactory?: import('@wrongstack/core').AgentFactory | undefined;
  /** Session store — enables session.resume and session.delete from the WebUI. */
  sessionStore?: SessionStore | undefined;
  /** Host Brain arbiter (same instance bound at TOKENS.BrainArbiter). */
  brain?: BrainArbiter | undefined;
  /** Host brain settings — the SAME object /brain mutates (shared ceiling). */
  brainSettings?: { maxAutoRisk: BrainAutoRisk } | undefined;
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
  /**
   * Called after session.resume swaps the active writer, with the new session
   * id. The host uses this to re-point crash-recovery state (active.json) at
   * the session that is now actually being written.
   */
  onSessionSwapped?: ((newSessionId: string) => void) | undefined;
  /** Memory store — enables the MemoryPanel (memory.list, memory.remember, memory.forget). */
  memoryStore?: MemoryStore | undefined;
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
  onAutonomySwitch?: ((mode: string) => void) | undefined;
}

interface ConnectedClient {
  ws: WebSocket;
  sessionId: string | null;
}

export async function runWebUI(opts: CliWebUIOptions): Promise<void> {
  const host = opts.host ?? process.env['WEBUI_HOST'] ?? process.env['WS_HOST'] ?? '127.0.0.1';
  const publicUrl = opts.publicUrl ?? process.env['WEBUI_PUBLIC_URL'];
  const publicWsUrl = opts.publicWsUrl ?? process.env['WEBUI_PUBLIC_WS_URL'];
  const requireToken = opts.requireToken ?? envFlag('WEBUI_REQUIRE_TOKEN');
  const requestedWsPort = opts.port ?? 3457;
  const requestedHttpPort = opts.httpPort ?? 3456;
  // Auto-advance past busy ports (unless WEBUI_STRICT_PORT) so this works
  // alongside other WebUI instances. HTTP resolved first → tidy adjacent pairs.
  const strictPort =
    process.env['WEBUI_STRICT_PORT'] === '1' || process.env['WEBUI_STRICT_PORT'] === 'true';
  let httpPort = requestedHttpPort;
  let wsPort = requestedWsPort;
  if (!strictPort) {
    httpPort = await findFreePort(host, requestedHttpPort);
    wsPort = await findFreePort(host, requestedWsPort, { exclude: new Set([httpPort]) });
  }
  const port = wsPort; // existing WS code below refers to `port`
  // Per-connection message rate limit. OFF by default — this is a local,
  // single-user tool and the limit (which counted pings/list calls too) was
  // tripping during normal use. Opt back in by setting WEBUI_RATE_LIMIT to a
  // positive messages-per-60s number (useful only when exposing on a LAN).
  const rateLimitMax = Number.parseInt(process.env['WEBUI_RATE_LIMIT'] ?? '0', 10);
  const clients = new Map<WebSocket, ConnectedClient>();
  // Pending permission confirmations keyed by toolUseId. When the agent emits
  // tool.confirm_needed, we stash its resolver here and forward the prompt to
  // the browser; the client's tool.confirm_result resolves it. This is what
  // makes approvals appear in the WebUI instead of the terminal.
  const pendingConfirms = new Map<string, (d: 'yes' | 'no' | 'always' | 'deny') => void>();
  const secretScrubber = new DefaultSecretScrubber();
  let abortController: AbortController | null = null;
  // Per-WebSocket abort controllers. The legacy single-slot `abortController`
  // above is the project-switch path's view (it always aborts the in-flight
  // run, no matter which socket initiated the switch) — kept for behavior
  // parity. The per-socket map scopes `case 'abort'` and `handleUserMessage`
  // so a second browser tab or a rapid same-tab abort cannot kill another
  // socket's run. Both are kept in sync.
  const abortControllers = new Map<WebSocket, AbortController>();

  // Custom context modes — file-backed (~/.wrongstack/custom-context-modes.json),
  // shared with the standalone server. Lazily loaded on first mode operation.
  let customModeStoreP: Promise<CustomModeStore> | null = null;
  const getCustomModeStore = (): Promise<CustomModeStore> => {
    customModeStoreP ??= (async () => {
      const dir = opts.globalConfigPath ? path.dirname(opts.globalConfigPath) : wstackGlobalRoot();
      const store = createCustomModeStore(dir);
      await store.load();
      return store;
    })();
    return customModeStoreP;
  };

  // AutoPhase handler — manages AutoPhase lifecycle via WS messages.
  // Initialized here so it can be used in the connection handler and message switch.
  const autoPhaseStoreDir = opts.projectRoot
    ? path.join(opts.projectRoot, '.wrongstack', 'autophase')
    : path.join(os.tmpdir(), '.wrongstack', 'autophase');
  const autoPhaseHandler = new AutoPhaseWebSocketHandler(
    opts.agent,
    opts.agent.ctx as Context,
    consoleLogger,
    autoPhaseStoreDir,
    opts.events,
    opts.projectRoot,
  );
  const worktreeHandler = new WorktreeWebSocketHandler(opts.events, consoleLogger);

  // Specs handler — FORGE-style dependency board over the shared per-project
  // SDD stores (where /sdd persists specs + task graphs).
  const specsPaths = opts.projectRoot
    ? resolveWstackPaths({ projectRoot: opts.projectRoot })
    : null;
  const specsHandler = new SpecsWebSocketHandler(
    specsPaths?.projectSpecs ?? path.join(os.tmpdir(), '.wrongstack', 'specs'),
    specsPaths?.projectTaskGraphs ?? path.join(os.tmpdir(), '.wrongstack', 'task-graphs'),
  );

  // SDD live board handler — same process as the run, so it streams instantly
  // off the shared EventBus (no disk polling) and steers via the control file.
  const sddBoardHandler = new SddBoardWebSocketHandler(
    specsPaths?.projectSddBoards ?? path.join(os.tmpdir(), '.wrongstack', 'sdd-boards'),
    opts.events,
  );

  // SDD wizard — interactive "New SDD Project" flow. Available only when the
  // host threaded its director-backed subagent factory (so the run uses the
  // same fleet as `/sdd execute`). The interview turns + run share that factory.
  const sddWizardHandler =
    opts.sddSubagentFactory && specsPaths
      ? new SddWizardWebSocketHandler(
          buildSddWizardDeps({
            agent: opts.agent,
            events: opts.events,
            projectRoot: opts.projectRoot ?? process.cwd(),
            subagentFactory: opts.sddSubagentFactory,
            paths: {
              projectSpecs: specsPaths.projectSpecs,
              projectTaskGraphs: specsPaths.projectTaskGraphs,
              projectSddBoards: specsPaths.projectSddBoards,
              projectDir: specsPaths.projectDir,
            },
          }),
        )
      : null;

  // ── Settings parity with the TUI ─────────────────────────────────────
  // Seed agent.ctx.meta from config.json on startup, then snapshot/persist
  // via the prefs handlers. Extracted to prefs-seeding.ts (PR 8 of Issue #30).
  await seedConfigToMeta(opts);

  const { prefSnapshot, persistPrefs } = createPrefsSeeding(opts);

  // Captured once at startup so stats.get can report elapsed time since the
  // session was opened, rather than the hardcoded 0 it used to send.
  const sessionStartedAt = Date.now();

  /**
   * Build a session.start payload enriched with per-model cost rates and
   * max-context cap. Used by the initial connect handler and every
   * broadcast path (model.switch, mode.switch, session.resume, etc.) so
   * the frontend always has the correct cost rates for live computation.
   *
   * Callers pass optional overrides for fields that vary per context
   * (reset, mode, replayMessages, etc.).
   */
  async function buildSessionStartPayload(overrides?: Record<string, unknown>, needsSetup = false) {
    let maxContext = 0;
    let inputCost = 0;
    let outputCost = 0;
    let cacheReadCost = 0;
    try {
      if (opts.modelsRegistry) {
        const m = await opts.modelsRegistry.getModel(
          opts.agent.ctx.provider.id,
          opts.agent.ctx.model,
        );
        const registryMax = m?.capabilities.maxContext;
        // Fall back to the live provider's capabilities if the registry has no override.
        // The provider is the authoritative source for the model's default context window.
        maxContext = registryMax ?? opts.agent.ctx.provider.capabilities?.maxContext ?? 0;
        const rates = getCostRates(m);
        inputCost = rates.input;
        outputCost = rates.output;
        cacheReadCost = rates.cacheRead;
      } else {
        // No registry — use the provider's default capabilities directly.
        maxContext = opts.agent.ctx.provider.capabilities?.maxContext ?? 0;
      }
    } catch {
      /* best-effort; cost stays $0 */
    }
    return {
      sessionId: opts.agent.ctx.session?.id ?? opts.session.id,
      model: opts.agent.ctx.model,
      provider: opts.agent.ctx.provider.id,
      mode: opts.modeId ?? 'default',
      projectName: opts.projectRoot ? path.basename(opts.projectRoot) : undefined,
      // Frontend reads `projectRoot` from session.start (ws-handlers setEnv) —
      // omitting it left the store's projectRoot empty after a project switch.
      projectRoot:
        opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '',
      cwd: opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '',
      needsSetup, // true when provider/model not configured and running in --webui mode
      contextMode: String(
        opts.agent.ctx.meta?.['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID,
      ),
      maxContext,
      inputCost,
      outputCost,
      cacheReadCost,
      ...overrides,
    };
  }

  // ── Client (REPL/TUI/WebUI) registration ─────────────────────────────────
  // Register this WebUI instance as a client in the global mailbox so other
  // TUIs, WebUIs, and REPLs on the same project can see it as "online".
  // Clients heartbeat more frequently than agents (15s vs 30s).
  let webuiClientId: string | null = null;
  let webuiHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let stopWebuiHqBridge: (() => void) | undefined;
  let webuiHqConnection: CliHqConnection | undefined;
  const CLIENT_HEARTBEAT_MS = 15_000;

  const registerWebuiClient = async (): Promise<string | null> => {
    if (!opts.projectRoot) return null;
    try {
      const projectRoot = opts.projectRoot;
      const projectDir = resolveProjectDir(projectRoot, wstackGlobalRoot());
      webuiHqConnection = startCliHqConnection({
        clientKind: 'webui',
        projectRoot,
        projectName: path.basename(projectRoot),
        appConfig: opts.appConfig,
        onConnect: (publisher) => {
          stopWebuiHqBridge?.();
          stopWebuiHqBridge = undefined;
          void import('@wrongstack/core')
            .then(({ startSessionTelemetryBridge }) => {
              stopWebuiHqBridge = startSessionTelemetryBridge({
                publisher,
                events: opts.events,
                sessionId: opts.session.id,
                projectRoot,
                projectName: path.basename(projectRoot),
                startedAt: new Date().toISOString(),
              });
            })
            .catch(() => {
              // telemetry optional
            });
        },
      });
      const mailbox = new GlobalMailbox(projectDir, opts.events, () =>
        webuiHqConnection?.getPublisher(),
      );
      webuiClientId = `webui@${crypto.randomUUID().slice(0, 8)}`;
      const projectName = opts.projectRoot ? path.basename(opts.projectRoot) : 'unknown';
      await mailbox.registerClient({
        clientId: webuiClientId,
        sessionId: opts.agent.ctx.session?.id ?? opts.session.id,
        name: `WebUI [${projectName}]`,
        source: 'webui',
        pid: process.pid,
      });

      webuiHeartbeatTimer = setInterval(() => {
        mailbox
          .clientHeartbeat({
            clientId: webuiClientId!,
            sessionId: opts.agent.ctx.session?.id ?? opts.session.id,
          })
          .catch(() => {
            // best-effort — ignore heartbeat failures during shutdown
          });
      }, CLIENT_HEARTBEAT_MS);
      webuiHeartbeatTimer.unref();

      return webuiClientId;
    } catch {
      // best-effort — client registration errors should not block WebUI startup
      return null;
    }
  };

  const unregisterWebuiClient = (): void => {
    if (webuiHeartbeatTimer) {
      clearInterval(webuiHeartbeatTimer);
      webuiHeartbeatTimer = null;
    }
    if (stopWebuiHqBridge) {
      stopWebuiHqBridge();
      stopWebuiHqBridge = undefined;
    }
    webuiHqConnection?.stop();
    webuiHqConnection = undefined;
  };

  // Register immediately (fire-and-forget so it doesn't block server startup)
  registerWebuiClient();

  // Generate auth token for WS connections and HTTP /ws-auth endpoint.
  // The token is passed to the frontend via the URL query param, which the
  // frontend then exchanges for an HttpOnly cookie via /ws-auth?token=...
  // This closes C-598 (query-string token exposure) after the first request.
  const wsToken = resolveAuthToken(opts.accessToken);
  const publicHostnames = [publicUrl, publicWsUrl]
    .map((value) => {
      if (!value) return undefined;
      try {
        return new URL(value).hostname;
      } catch {
        return undefined;
      }
    })
    .filter((value): value is string => Boolean(value));
  const accessUrl = buildWebUIAccessUrl({
    host,
    port: httpPort,
    token: wsToken,
    publicUrl,
  });

  const wss = new WebSocketServer({ port, host, maxPayload: 1 * 1024 * 1024 });

  console.log(`[WebUI] WebSocket server starting on ws://${host}:${port}`);

  // Serve the React frontend over HTTP so `wrongstack --webui` is a one-command
  // launch (open the printed URL) instead of only a WS bridge. The dist
  // discovery + HTTP server bring-up live in
  // `webui-server/static-serve.ts`; we just hand it the options and
  // wire the open-browser callback on top. If the webui package
  // isn't built, `startStaticServe` returns null and we degrade
  // gracefully to WS-only (the original behavior).
  // Captured from the status block below so `POST /api/fleet/ping` can trigger
  // an immediate fleet re-broadcast (push-on-write from a TUI/REPL).
  let fleetBroadcastCli: (() => Promise<void>) | null = null;
  const httpServer = startStaticServe({
    host,
    httpPort,
    wsPort,
    globalRoot: path.dirname(opts.globalConfigPath ?? ''),
    onFleetPing: () => {
      void fleetBroadcastCli?.();
    },
    publicWsUrl,
    apiToken: wsToken,
    requireToken,
  });
  if (httpServer) {
    announceWebuiReady({
      server: httpServer.server,
      host,
      httpPort,
      wsPort,
      open: !!opts.open,
      wsToken,
      publicUrl,
    });
  } else {
    console.warn(
      `[WebUI] Frontend not served (run \`pnpm --filter @wrongstack/webui build\`). ` +
        `WS bridge still active on ws://${host}:${wsPort}.`,
    );
  }

  // Record this instance so it shows up in `wstackui --list` /
  // ~/.wrongstack/webui-instances.json alongside standalone instances.
  const registryBaseDir = opts.globalConfigPath ? path.dirname(opts.globalConfigPath) : undefined;
  if (opts.projectRoot) {
    registerWebuiInstance({
      pid: process.pid,
      host,
      httpPort,
      wsPort,
      publicUrl,
      projectRoot: opts.projectRoot,
      startedAt: new Date().toISOString(),
      registryBaseDir,
    });
  }
  // Auth token is delivered through the printed first-load URL and then
  // exchanged for an HttpOnly cookie by /ws-auth.

  // Subscribe to events once
  const eventUnsubscribers: Array<() => void> = [];

  // ── Fleet concurrency tracking ────────────────────────────────────────────
  // Tracks how many subagents are currently active (running) so the WebUI's
  // ConcurrencyGauge can show [████░░] 2/4 instead of always 0/4.
  // The leader is NOT counted — it's the host process, not a spawned worker.
  let fleetConcurrency = 0;
  // Default max matches the CLI default fleet size (4). A future
  // fleet.max_concurrency kernel event could override this dynamically.
  let fleetConcurrencyMax = 4;
  const emitConcurrency = () =>
    broadcast({
      type: 'fleet.concurrency_update',
      payload: sessionPayload({ fleetConcurrency, fleetConcurrencyMax }),
    });

  // Coalesce high-volume live events on the server before they hit every
  // connected browser tab. The frontend also coalesces per animation frame,
  // but without this layer long streams still create one WebSocket message per
  // provider token/tool progress event.
  const STREAM_COALESCE_MS = 16;
  const STREAM_COALESCE_MAX_CHARS = 8 * 1024;
  const currentSessionId = (): string => opts.agent.ctx.session?.id ?? opts.session.id;
  const sessionPayload = <T extends Record<string, unknown>>(payload: T): T & { sessionId: string } => {
    const provided = payload['sessionId'];
    const sessionId = typeof provided === 'string' && provided.length > 0 ? provided : currentSessionId();
    return { ...payload, sessionId };
  };
  let textDeltaBuffer = '';
  let textDeltaSessionId: string | undefined;
  let textDeltaTimer: ReturnType<typeof setTimeout> | null = null;
  let thinkingDeltaBuffer = '';
  let thinkingDeltaSessionId: string | undefined;
  let thinkingDeltaTimer: ReturnType<typeof setTimeout> | null = null;
  const toolProgressBuffers = new Map<
    string,
    {
      sessionId?: string | undefined;
      id: string;
      name: string;
      eventType: string;
      text: string;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();

  const flushTextDelta = (): void => {
    if (textDeltaTimer) {
      clearTimeout(textDeltaTimer);
      textDeltaTimer = null;
    }
    if (!textDeltaBuffer) return;
    const text = textDeltaBuffer;
    const sessionId = textDeltaSessionId;
    textDeltaBuffer = '';
    textDeltaSessionId = undefined;
    broadcast({
      type: 'provider.text_delta',
      payload: sessionPayload({ sessionId, text, messageId: 'current' }),
    });
  };

  const flushThinkingDelta = (): void => {
    if (thinkingDeltaTimer) {
      clearTimeout(thinkingDeltaTimer);
      thinkingDeltaTimer = null;
    }
    if (!thinkingDeltaBuffer) return;
    const text = thinkingDeltaBuffer;
    const sessionId = thinkingDeltaSessionId;
    thinkingDeltaBuffer = '';
    thinkingDeltaSessionId = undefined;
    broadcast({
      type: 'provider.thinking_delta',
      payload: sessionPayload({ sessionId, text }),
    });
  };

  const queueTextDelta = (text: string, sessionId?: string | undefined): void => {
    if (!text) return;
    if (textDeltaBuffer && textDeltaSessionId !== sessionId) {
      flushTextDelta();
    }
    textDeltaSessionId = sessionId;
    textDeltaBuffer += text;
    if (textDeltaBuffer.length >= STREAM_COALESCE_MAX_CHARS) {
      flushTextDelta();
      return;
    }
    if (!textDeltaTimer) {
      textDeltaTimer = setTimeout(flushTextDelta, STREAM_COALESCE_MS);
      textDeltaTimer.unref?.();
    }
  };

  const queueThinkingDelta = (text: string, sessionId?: string | undefined): void => {
    if (!text) return;
    if (thinkingDeltaBuffer && thinkingDeltaSessionId !== sessionId) {
      flushThinkingDelta();
    }
    thinkingDeltaSessionId = sessionId;
    thinkingDeltaBuffer += text;
    if (thinkingDeltaBuffer.length >= STREAM_COALESCE_MAX_CHARS) {
      flushThinkingDelta();
      return;
    }
    if (!thinkingDeltaTimer) {
      thinkingDeltaTimer = setTimeout(flushThinkingDelta, STREAM_COALESCE_MS);
      thinkingDeltaTimer.unref?.();
    }
  };

  const flushToolProgress = (id: string): void => {
    const buffered = toolProgressBuffers.get(id);
    if (!buffered) return;
    if (buffered.timer) clearTimeout(buffered.timer);
    toolProgressBuffers.delete(id);
    if (!buffered.text) return;
    broadcast({
      type: 'tool.progress',
      payload: sessionPayload({
        sessionId: buffered.sessionId,
        name: buffered.name,
        id: buffered.id,
        event: { type: buffered.eventType, text: buffered.text },
      }),
    });
  };

  const flushAllStreamBuffers = (): void => {
    flushTextDelta();
    flushThinkingDelta();
    for (const id of [...toolProgressBuffers.keys()]) flushToolProgress(id);
  };

  const queueToolProgress = (payload: {
    sessionId?: string | undefined;
    id: string;
    name: string;
    event: { type?: string | undefined; text?: string | undefined };
  }): void => {
    const text = payload.event.text;
    if (!text) {
      flushToolProgress(payload.id);
      broadcast({ type: 'tool.progress', payload: sessionPayload(payload as Record<string, unknown>) });
      return;
    }

    const eventType = payload.event.type ?? 'progress';
    const existing = toolProgressBuffers.get(payload.id);
    if (existing && existing.sessionId !== payload.sessionId) flushToolProgress(payload.id);
    if (existing && existing.eventType !== eventType) flushToolProgress(payload.id);
    const buffered = toolProgressBuffers.get(payload.id) ?? {
      sessionId: payload.sessionId,
      id: payload.id,
      name: payload.name,
      eventType,
      text: '',
      timer: null,
    };
    buffered.sessionId = payload.sessionId;
    buffered.name = payload.name;
    buffered.text += buffered.text ? `\n${text}` : text;
    toolProgressBuffers.set(payload.id, buffered);

    if (buffered.text.length >= STREAM_COALESCE_MAX_CHARS) {
      flushToolProgress(payload.id);
      return;
    }
    if (!buffered.timer) {
      buffered.timer = setTimeout(() => flushToolProgress(payload.id), STREAM_COALESCE_MS);
      buffered.timer.unref?.();
    }
  };

  function setupEvents() {
    // Clear any existing subscriptions
    for (const unsub of eventUnsubscribers) unsub();
    eventUnsubscribers.length = 0;

    // ── Leader identity — the host is always the leader (agentId 'leader').
    // Emit once so the WebUI's fleet store sets leaderId and shows the crown.
    broadcast({
      type: 'subagent.event',
      payload: sessionPayload({
        kind: 'leader_updated',
        subagentId: 'leader',
        isLeader: true,
        name: 'Leader',
        status: 'running',
      }),
    });

    // ── Fleet concurrency — emit the initial 0/N state so the gauge
    // renders immediately instead of waiting for the first spawn event.
    emitConcurrency();

    // iteration.started
    eventUnsubscribers.push(
      opts.events.on('iteration.started', (e) => {
        // Include maxIterations (from the seeded meta) so the UI's
        // "iteration N / max" affordance works the same as under the
        // standalone server, which already sends it.
        const maxIt = opts.agent.ctx.meta['maxIterations'];
        broadcast({
          type: 'iteration.started',
          payload: sessionPayload({
            sessionId: e.sessionId,
            index: e.index,
            ...(typeof maxIt === 'number' ? { maxIterations: maxIt } : {}),
          }),
        });
      }),
    );

    eventUnsubscribers.push(
      opts.events.on('iteration.completed', (e) => {
        broadcast({
          type: 'iteration.completed',
          payload: sessionPayload({ sessionId: e.sessionId, index: e.index, totalIterations: e.index + 1 }),
        });
      }),
      opts.events.on('iteration.limit_reached', (e) => {
        broadcast({
          type: 'iteration.limit_reached',
          payload: sessionPayload({
            sessionId: e.sessionId,
            currentIterations: e.currentIterations,
            currentLimit: e.currentLimit,
          }),
        });
      }),
    );

    // provider.text_delta
    eventUnsubscribers.push(
      opts.events.on('provider.text_delta', (e) => {
        flushThinkingDelta();
        queueTextDelta(e.text, e.sessionId);
      }),
    );

    // provider.thinking_delta — extended-thinking deltas. The WebUI renders a
    // transient "Thinking…" chip from these and archives the full burst as a
    // collapsible thinking log when the iteration ends.
    eventUnsubscribers.push(
      opts.events.on('provider.thinking_delta', (e) => {
        queueThinkingDelta(e.text, e.sessionId);
      }),
    );

    eventUnsubscribers.push(
      opts.events.on('provider.stream_error', (e) => {
        broadcast({
          type: 'provider.stream_error',
          payload: sessionPayload({ sessionId: e.sessionId, eventType: e.eventType, message: e.msg }),
        });
      }),
    );

    // tool.started
    eventUnsubscribers.push(
      opts.events.on('tool.started', (e) => {
        flushAllStreamBuffers();
        broadcast({
          type: 'tool.started',
          payload: sessionPayload({
            sessionId: e.sessionId,
            id: e.id,
            name: e.name,
            input: secretScrubber.scrubObject(e.input),
            messageId: `tool_${e.id}`,
          }),
        });
      }),
    );

    // tool.progress
    eventUnsubscribers.push(
      opts.events.on('tool.progress', (e) => {
        queueToolProgress({
          sessionId: e.sessionId,
          name: e.name,
          id: e.id,
          event: e.event,
        });
      }),
    );

    // tool.executed
    eventUnsubscribers.push(
      opts.events.on('tool.executed', (e) => {
        flushAllStreamBuffers();
        broadcast({
          type: 'tool.executed',
          payload: sessionPayload({
            sessionId: e.sessionId,
            // Forward the tool_use id so the WebUI can correlate this with
            // the matching tool.started bubble for parallel tool calls.
            id: e.id,
            name: e.name,
            durationMs: e.durationMs,
            ok: e.ok,
            input: secretScrubber.scrubObject(e.input),
            output: secretScrubber.scrubObject(e.output),
          }),
        });

        // Always broadcast current todos so the panel stays in sync.
        broadcast({
          type: 'todos.updated',
          payload: sessionPayload({ sessionId: e.sessionId, todos: [...opts.agent.ctx.todos] }),
        });

        // After task/plan/todo tool executions, also broadcast those snapshots.
        if (e.name === 'task' || e.name === 'plan' || e.name === 'todo') {
          void (async () => {
            try {
              const taskPath = (opts.agent.ctx.meta as Record<string, unknown>)['task.path'];
              if (typeof taskPath === 'string' && taskPath) {
                const { loadTasks } = await import('@wrongstack/core');
                const file = await loadTasks(taskPath);
                broadcast({
                  type: 'tasks.updated',
                  payload: sessionPayload({ sessionId: e.sessionId, tasks: file?.tasks ?? [] }),
                });
              }
            } catch {
              /* best-effort */
            }
            try {
              const planPath = (opts.agent.ctx.meta as Record<string, unknown>)['plan.path'];
              if (typeof planPath === 'string' && planPath) {
                const { loadPlan } = await import('@wrongstack/core');
                const plan = await loadPlan(planPath);
                broadcast({
                  type: 'plan.updated',
                  payload: sessionPayload({
                    sessionId: e.sessionId,
                    plan: plan ?? {
                      version: 1,
                      sessionId: e.sessionId ?? currentSessionId(),
                      updatedAt: new Date().toISOString(),
                      items: [],
                    },
                  }),
                });
              }
            } catch {
              /* best-effort */
            }
          })();
        }
      }),
    );

    eventUnsubscribers.push(
      opts.events.on('tool.loop_detected', (e) => {
        broadcast({
          type: 'tool.loop_detected',
          payload: sessionPayload({
            sessionId: e.sessionId,
            tools: e.tools,
            repeatCount: e.repeatCount,
            iteration: e.iteration,
            kind: e.kind,
          }),
        });
      }),
      opts.events.on('trust.persisted', (e) => {
        broadcast({
          type: 'trust.persisted',
          payload: sessionPayload({ sessionId: e.sessionId, tool: e.tool, pattern: e.pattern, decision: e.decision }),
        });
      }),
      opts.events.on('delegate.started', (e) => {
        broadcast({
          type: 'delegate.started',
          payload: sessionPayload({ sessionId: e.sessionId, target: e.target, task: e.task }),
        });
      }),
      opts.events.on('delegate.completed', (e) => {
        broadcast({
          type: 'delegate.completed',
          payload: sessionPayload({
            sessionId: e.sessionId,
            target: e.target,
            task: e.task,
            ok: e.ok,
            status: e.status,
            summary: e.summary,
            durationMs: e.durationMs,
            iterations: e.iterations,
            toolCalls: e.toolCalls,
            costUsd: e.costUsd,
            subagentId: e.subagentId,
          }),
        });
      }),
    );

    // provider.response
    eventUnsubscribers.push(
      opts.events.on('provider.response', (e) => {
        flushAllStreamBuffers();
        broadcast({
          type: 'provider.response',
          payload: sessionPayload({
            sessionId: e.sessionId,
            usage: e.usage,
            stopReason: e.stopReason,
            messageId: 'current',
          }),
        });
      }),
    );

    eventUnsubscribers.push(
      opts.events.on('ctx.pct', (e) => {
        broadcast({
          type: 'ctx.pct',
          payload: sessionPayload({ sessionId: e.sessionId, load: e.load, tokens: e.tokens, maxContext: e.maxContext }),
        });
        broadcast({
          type: 'subagent.event',
          payload: sessionPayload({
            sessionId: e.sessionId,
            kind: 'ctx_pct',
            subagentId: 'leader',
            load: e.load,
            tokens: e.tokens,
            maxContext: e.maxContext,
          }),
        });
      }),
      opts.events.on('ctx.max_context', (e) => {
        broadcast({
          type: 'ctx.max_context',
          payload: sessionPayload({ sessionId: e.sessionId, providerId: e.providerId, modelId: e.modelId, maxContext: e.maxContext }),
        });
      }),
      opts.events.on('context.repaired', (e) => {
        broadcast({
          type: 'context.repaired',
          payload: sessionPayload({
            sessionId: e.sessionId,
            removedToolUses: e.removedToolUses,
            removedToolResults: e.removedToolResults,
            removedMessages: e.removedMessages,
          }),
        });
      }),
      opts.events.on('token.threshold', (e) => {
        broadcast({
          type: 'token.threshold',
          payload: sessionPayload({ sessionId: e.sessionId, used: e.used, limit: e.limit }),
        });
      }),
      opts.events.on('token.cost_estimate_unavailable', (e) => {
        broadcast({
          type: 'token.cost_estimate_unavailable',
          payload: sessionPayload({ sessionId: e.sessionId, model: e.model }),
        });
      }),
    );

    eventUnsubscribers.push(
      opts.events.on('provider.retry', (e) => {
        broadcast({
          type: 'provider.retry',
          payload: sessionPayload({
            sessionId: e.sessionId,
            providerId: e.providerId,
            attempt: e.attempt,
            delayMs: e.delayMs,
            status: e.status,
            description: e.description,
          }),
        });
      }),
      opts.events.on('provider.error', (e) => {
        broadcast({
          type: 'provider.error',
          payload: sessionPayload({
            sessionId: e.sessionId,
            providerId: e.providerId,
            status: e.status,
            description: e.description,
            retryable: e.retryable,
          }),
        });
      }),
      opts.events.on('provider.fallback', (e) => {
        broadcast({
          type: 'provider.fallback',
          payload: sessionPayload({
            sessionId: e.sessionId,
            from: e.from,
            to: e.to,
            status: e.status,
            providerSwitched: e.providerSwitched,
          }),
        });
      }),
      opts.events.on('compaction.fired', (e) => {
        broadcast({
          type: 'context.compacted',
          payload: sessionPayload({
            sessionId: e.sessionId,
            before: e.report.before,
            after: e.report.after,
            saved: Math.max(0, e.report.before - e.report.after),
            reductions: e.report.reductions,
          }),
        });
      }),
      opts.events.on('compaction.failed', (e) => {
        broadcast({
          type: 'compaction.failed',
          payload: sessionPayload({
            sessionId: e.sessionId,
            message: e.err.message,
            aggressive: e.aggressive,
            level: e.level,
            tokens: e.tokens,
            maxContext: e.maxContext,
            load: e.load,
            fatal: e.fatal,
          }),
        });
      }),
      opts.events.on('mcp.server.connected', (e) => {
        broadcast({
          type: 'mcp.server.connected',
          payload: { name: e.name, toolCount: e.toolCount },
        });
      }),
      opts.events.on('mcp.server.reconnected', (e) => {
        broadcast({
          type: 'mcp.server.reconnected',
          payload: { name: e.name, toolCount: e.toolCount },
        });
      }),
      opts.events.on('mcp.server.disconnected', (e) => {
        broadcast({
          type: 'mcp.server.disconnected',
          payload: { name: e.name, reason: e.reason },
        });
      }),
      opts.events.on('coordinator.stats', (e) => {
        broadcast({
          type: 'coordinator.stats',
          payload: sessionPayload({
            sessionId: e.sessionId,
            total: e.total,
            running: e.running,
            idle: e.idle,
            stopped: e.stopped,
            inFlight: e.inFlight,
            pending: e.pending,
            completed: e.completed,
            subagentStatuses: e.subagentStatuses.map((s) => ({
              id: s.subagentId,
              name: s.subagentId,
              status: s.status,
              currentTask: s.taskId,
            })),
          }),
        });
      }),
    );

    // error
    eventUnsubscribers.push(
      opts.events.on('error', (e) => {
        broadcast({
          type: 'error',
          payload: sessionPayload({
            sessionId: e.sessionId,
            phase: e.phase,
            message: e.err instanceof Error ? e.err.message : String(e.err),
          }),
        });
      }),
    );

    eventUnsubscribers.push(
      opts.events.on('session.damaged', (e) => {
        broadcast({
          type: 'session.damaged',
          payload: { sessionId: e.sessionId, detail: e.detail },
        });
      }),
      opts.events.on('session.rewound', (e) => {
        broadcast({
          type: 'session.rewound',
          payload: sessionPayload({
            sessionId: e.sessionId,
            toPromptIndex: e.toPromptIndex,
            revertedFiles: e.revertedFiles,
            removedEvents: e.removedEvents,
          }),
        });
      }),
      opts.events.on('checkpoint.written', (e) => {
        broadcast({
          type: 'checkpoint.written',
          payload: sessionPayload({
            sessionId: e.sessionId,
            promptIndex: e.promptIndex,
            promptPreview: e.promptPreview,
            ts: e.ts,
            fileCount: e.fileCount,
          }),
        });
      }),
      opts.events.on('in_flight.started', (e) => {
        broadcast({
          type: 'in_flight.started',
          payload: sessionPayload({ sessionId: e.sessionId, context: e.context, ts: e.ts }),
        });
      }),
      opts.events.on('in_flight.ended', (e) => {
        broadcast({
          type: 'in_flight.ended',
          payload: sessionPayload({ sessionId: e.sessionId, reason: e.reason, ts: e.ts }),
        });
      }),
      opts.events.on('concurrency.changed', (e) => {
        fleetConcurrencyMax = Math.max(1, e.n);
        emitConcurrency();
      }),
    );

    // tool.confirm_needed — forward permission prompts to the browser so the
    // user approves/denies in the WebUI rather than the terminal. Requires the
    // agent to be in event-driven confirmation mode (the --webui launch path
    // calls disableInteractiveConfirmation()).
    eventUnsubscribers.push(
      opts.events.on('tool.confirm_needed', (e) => {
        const id = e.toolUseId ?? `confirm_${Date.now()}`;
        pendingConfirms.set(id, e.resolve);
        broadcast({
          type: 'tool.confirm_needed',
          payload: sessionPayload({
            sessionId: e.sessionId,
            id,
            toolName: e.tool?.name ?? 'unknown',
            input: secretScrubber.scrubObject(e.input),
            suggestedPattern: e.suggestedPattern,
          }),
        });
      }),
    );

    // Subagent fleet lifecycle. The kernel emits a rich subagent.* catalog on
    // the host bus (spawn → task → per-tool → periodic summary → completion).
    // We flatten the relevant ones into a single `subagent.event` stream with a
    // `kind` discriminator so the WebUI can render a live fleet roster (the
    // nickname'd leader/worker agents) without subscribing to the director-only
    // FleetBus. No tool inputs/outputs are forwarded here — only names + counts
    // — so there's nothing to scrub.
    const forwardSubagent = (kind: string, payload: Record<string, unknown>) =>
      broadcast({ type: 'subagent.event', payload: sessionPayload({ kind, ...payload }) });
    eventUnsubscribers.push(
      opts.events.on('subagent.spawned', (e) => {
        fleetConcurrency += 1;
        emitConcurrency();
        forwardSubagent('spawned', {
          sessionId: e.sessionId,
          subagentId: e.subagentId,
          taskId: e.taskId,
          name: e.name,
          provider: e.provider,
          model: e.model,
          description: e.description,
        });
      }),
      opts.events.on('subagent.task_started', (e) =>
        forwardSubagent('task_started', {
          sessionId: e.sessionId,
          subagentId: e.subagentId,
          taskId: e.taskId,
          description: e.description,
        }),
      ),
      opts.events.on('subagent.tool_executed', (e) =>
        forwardSubagent('tool_executed', {
          sessionId: e.sessionId,
          subagentId: e.subagentId,
          toolName: e.name,
          durationMs: e.durationMs,
          ok: e.ok,
        }),
      ),
      opts.events.on('subagent.iteration_summary', (e) =>
        forwardSubagent('iteration_summary', {
          sessionId: e.sessionId,
          subagentId: e.subagentId,
          iteration: e.iteration,
          toolCalls: e.toolCalls,
          costUsd: e.costUsd,
          currentTool: e.currentTool,
          partialText: e.partialText,
        }),
      ),
      opts.events.on('subagent.budget_warning', (e) =>
        forwardSubagent('budget_warning', {
          sessionId: e.sessionId,
          subagentId: e.subagentId,
          budgetKind: e.kind,
          used: e.used,
          limit: e.limit,
        }),
      ),
      opts.events.on('subagent.budget_extended', (e) =>
        forwardSubagent('budget_extended', {
          sessionId: e.sessionId,
          subagentId: e.subagentId,
          budgetKind: e.kind,
          newLimit: e.newLimit,
          totalExtensions: e.totalExtensions,
        }),
      ),
      opts.events.on('subagent.ctx_pct', (e) =>
        forwardSubagent('ctx_pct', {
          sessionId: e.sessionId,
          subagentId: e.subagentId,
          load: e.load,
          tokens: e.tokens,
          maxContext: e.maxContext,
        }),
      ),
      opts.events.on('subagent.task_completed', (e) => {
        fleetConcurrency = Math.max(0, fleetConcurrency - 1);
        emitConcurrency();
        forwardSubagent('task_completed', {
          sessionId: e.sessionId,
          subagentId: e.subagentId,
          status: e.status,
          iterations: e.iterations,
          toolCalls: e.toolCalls,
          finalText: (e as Record<string, unknown>).finalText as string | undefined,
          failureReason: e.error?.kind,
          error: e.error ? { kind: e.error.kind, message: e.error.message } : undefined,
        });
      }),
    );

    // ── Agent timeline events — WebUI conversation stream ─────────────
    opts.events.on('agent.timeline.message', (e) => {
      broadcast({
        type: 'agent.timeline.message',
        payload: sessionPayload({
          sessionId: e.sessionId,
          subagentId: e.subagentId,
          agentName: e.agentName,
          content: e.content,
          kind: e.kind,
          iteration: e.iteration,
          ts: e.ts,
          toolName: e.toolName,
          costUsd: e.costUsd,
        }),
      });
    });
    opts.events.on('agent.status_changed', (e) => {
      broadcast({
        type: 'agent.status_changed',
        payload: sessionPayload({
          sessionId: e.sessionId,
          subagentId: e.subagentId,
          agentName: e.agentName,
          status: e.status,
          ts: e.ts,
          summary: e.summary,
          task: e.task,
        }),
      });
    });

    // eternal-autonomy iteration events. Each iteration the engine
    // completes lands here and is fanned out to every connected client
    // so the frontend can render a live timeline of the autonomous loop.
    // Wired through `createEternalSubscription` (shared with `@wrongstack/webui/server`'s
    // standalone `startWebUI`) so the `eternal.iteration` payload shape stays
    // in lockstep across the two entry points — earlier revisions spelled out
    // every field by hand here, which drifted from the standalone shape
    // (`{ entry: JournalEntry }`) and forced the frontend to keep two
    // deserializers. The whole `JournalEntry` (including the CLI-only
    // `costUsd` delta) now rides in the `entry` field.
    if (opts.subscribeEternalIteration) {
      const subscription = createEternalSubscription(
        opts.subscribeEternalIteration,
        (_liveClients, msg) => broadcast(msg),
        () => clients,
      );
      eventUnsubscribers.push(() => subscription.dispose());
    }

    // ── Mailbox events — broadcast to WebUI for real-time per-project visibility ──
    // Enables the WebUI to update its online agent count and mailbox panel without polling.
    eventUnsubscribers.push(
      opts.events.onPattern('mailbox.*', (eventName, payload) => {
        broadcast({
          type: 'mailbox.event',
          payload: sessionPayload({ event: eventName, ...(payload as Record<string, unknown>) }),
        });
      }),
    );

    // ── Brain events — decisions + proactive interventions, live in the browser ──
    eventUnsubscribers.push(
      opts.events.onPattern('brain.*', (eventName, payload) => {
        broadcast({
          type: 'brain.event',
          payload: sessionPayload({ event: eventName, ...(payload as Record<string, unknown>) }),
        });
      }),
    );
  }

  // Shared state for the extracted ws-handler groups (PR 5 of #30).
  // `send`/`broadcast` are hoisted function declarations, so capturing
  // them here is safe even though they're defined further down.
  const wsHandlerCtx: WsHandlerContext = {
    providerStore: createProviderConfigStore(
      opts.globalConfigPath,
      // Use the in-memory merged config providers so the WebUI sees the
      // same provider list the agent uses. Without this, providers stored
      // only in the project-local config (config.local.json) would be
      // invisible to the WebUI's saved-providers panel because the store
      // reads exclusively from the global config file.
      () => (opts.appConfig?.providers as Record<string, ProviderConfig> | undefined) ?? {},
    ),
    modelsRegistry: opts.modelsRegistry,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  // Hot-reload provider credentials when config.json changes on disk (another
  // terminal's `wstack auth`, a provider panel in a different window, or a
  // manual edit). Rebuild the live agent's provider so the next message uses
  // the new key without a server restart, and re-broadcast the saved-providers
  // projection so every connected panel re-renders. Mirrors the live-swap that
  // `handleModelSwitch` already does. Escape hatch: WRONGSTACK_DISABLE_CONFIG_WATCH=1.
  let credentialWatcherClose: (() => void) | undefined;
  if (opts.globalConfigPath && process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'] !== '1') {
    let lastActiveCfg = JSON.stringify(
      opts.appConfig?.providers?.[opts.agent.ctx.provider.id] ?? null,
    );
    const watcher = watchProviderConfig(
      opts.globalConfigPath,
      getVault(opts.globalConfigPath),
      (snapshot) => {
        // Best-effort: refresh the in-memory providers ref the panel reads from
        // (skipped silently when appConfig is frozen — the broadcast below still
        // pushes the fresh map, so panels stay correct either way).
        try {
          if (opts.appConfig && !Object.isFrozen(opts.appConfig)) {
            opts.appConfig.providers = snapshot.providers;
          }
        } catch {
          /* frozen / read-only appConfig — ignore */
        }
        broadcastSaved(wsHandlerCtx, snapshot.providers);

        const activeId = opts.agent.ctx.provider.id;
        const newCfgStr = JSON.stringify(snapshot.providers[activeId] ?? null);
        if (newCfgStr === lastActiveCfg) return; // active provider creds unchanged
        lastActiveCfg = newCfgStr;
        try {
          const newCfg = snapshot.providers[activeId] ?? {
            type: activeId,
            ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
            ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
          };
          const oldMax = opts.agent.ctx.provider.capabilities?.maxContext;
          const prov = makeProviderFromConfig(activeId, { ...newCfg, type: activeId });
          // Key-only change keeps the same model/context window — preserve the
          // resolved maxContext instead of falling back to the family default.
          if (oldMax != null && prov.capabilities) prov.capabilities.maxContext = oldMax;
          opts.agent.ctx.provider = prov;
          console.log(`[WebUI] Provider credentials reloaded from config.json (${activeId})`);
        } catch (err) {
          console.warn(
            `[WebUI] Credential hot-reload failed for ${activeId}: ${toErrorMessage(err)}`,
          );
        }
      },
      { warn: (m) => console.warn(`[WebUI] Config watcher: ${m}`) },
    );
    credentialWatcherClose = watcher.close;
  }

  const brainCtx: BrainHandlerContext = {
    brainSettings: opts.brainSettings,
    getBrainLog: opts.getBrainLog,
    // Prefer the host-supplied arbiter; otherwise resolve the one bound
    // in the agent container (if any). Mirrors the former inline lookup.
    resolveArbiter: () =>
      opts.brain ??
      (opts.agent.container.has(TOKENS.BrainArbiter)
        ? opts.agent.container.resolve(TOKENS.BrainArbiter)
        : undefined),
    getSessionId: currentSessionId,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  const introspectionCtx: IntrospectionContext = {
    agent: opts.agent,
    skillLoader: opts.skillLoader,
    modelsRegistry: opts.modelsRegistry,
    projectRoot: opts.projectRoot,
    sessionId: opts.session.id,
    sessionStartedAt,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  // Shared skills handlers context. The CLI passes its own skillLoader; the
  // installer (backing install/uninstall/update) is constructed here the same
  // way the standalone WebUI server does. Absent skillLoader ⇒ skills feature
  // disabled and the handlers respond with an "enabled: false" payload.
  const skillsProjectRoot =
    opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '';
  const skillsCtx: SkillsContext = {
    skillLoader: opts.skillLoader,
    skillInstaller: opts.skillLoader
      ? new SkillInstaller({
          manifestPath: path.join(wstackGlobalRoot(), 'installed-skills.json'),
          projectSkillsDir: path.join(skillsProjectRoot, '.wrongstack', 'skills'),
          globalSkillsDir: path.join(wstackGlobalRoot(), 'skills'),
          projectHash: skillsProjectRoot ? projectHash(skillsProjectRoot) : '',
          skillLoader: opts.skillLoader,
        })
      : undefined,
    projectRoot: skillsProjectRoot,
  };

  // Prompt library context — shared handlers, one source of truth with the
  // standalone server. Absent promptLoader ⇒ handlers respond "unavailable".
  const promptsCtx: PromptsContext = {
    promptLoader: opts.promptLoader,
    promptUsage: new PromptUsageStore(path.join(wstackGlobalRoot(), 'prompt-usage.json')),
  };

  // Design Studio context — same project root, live agent ctx so design.use
  // pins the active kit for the next turn.
  const designCtx: DesignContext = {
    projectRoot: skillsProjectRoot,
    agentMeta: opts.agent.ctx as unknown as { meta: Record<string, unknown> },
  };

  const worklistCtx: WorklistContext = {
    agent: opts.agent,
    sessionId: opts.session.id,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  const agentConfigCtx: AgentConfigContext = {
    agent: opts.agent,
    modeStore: opts.modeStore,
    globalConfigPath: opts.globalConfigPath,
    buildSessionStart: (overrides) => buildSessionStartPayload(overrides),
    modelsRegistry: opts.modelsRegistry,
    onMaxContextResolved: opts.onModelContextResolved,
    persistPrefs,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  const prefsCtx: PrefsContext = {
    agent: opts.agent,
    prefSnapshot,
    persistPrefs,
    onAutonomySwitch: opts.onAutonomySwitch,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  // projects.select re-roots the run in place, so `opts` is passed by
  // reference (the handlers mutate opts.projectRoot / opts.sessionStore).
  const projectsCtx: ProjectsContext = {
    opts,
    abortControllers,
    abortLegacyRun: () => {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
    },
    buildSessionStart: (overrides) => buildSessionStartPayload(overrides),
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  const contextHandlerCtx: ContextHandlerContext = {
    agent: opts.agent,
    buildSessionStart: (overrides) => buildSessionStartPayload(overrides),
    getCustomModeStore,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  // Bare messaging surface for handler groups that need no run-loop state.
  const wsCommon: WsCommon = { send, broadcast, log: (m) => console.log(m) };

  // Bare mailbox context for the mailbox ws-handlers (PR 8 of Issue #30).
  const mailboxCtx: MailboxContext = {
    agent: opts.agent as MailboxContext['agent'],
    globalConfigPath: opts.globalConfigPath ?? '',
    events: opts.events,
    send: send as unknown as (ws: unknown, msg: Record<string, unknown>) => void,
    broadcast: broadcast as unknown as (msg: Record<string, unknown>) => void,
    log: (m: string) => console.log(m),
  };

  // `opts` is passed by reference so the session handlers read live
  // agent.ctx.session / opts.sessionStore at call time.
  const sessionsCtx: SessionsContext = {
    opts,
    buildSessionStart: (overrides) => buildSessionStartPayload(overrides),
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  // Connection-level cases (user_message/abort/ping/tool.confirm_result).
  // `opts` is by reference so `user_message` runs the live agent; the two
  // maps are the SAME instances the connection/close handlers mutate.
  const connectionCtx: ConnectionContext = {
    opts,
    abortControllers,
    pendingConfirms,
    send,
    broadcast,
    log: (m) => console.log(m),
  };
  const stopped = new Promise<void>((resolve) => {
    wss.on('listening', () => {
      console.log(`[WebUI] WebSocket server running on ws://${host}:${port}`);
      setupEvents();
      opts.onListening?.({ httpPort, wsPort, host, url: accessUrl });

      // ── Live session status poll ──────────────────────────────────
      // Periodically read the cross-process SessionRegistry and push
      // live agent/session status to all connected WebSocket clients.
      // This keeps the WebUI session panel in sync even when agents
      // run in background (project switches, multiple processes).
      const globalRoot = opts.globalConfigPath ? path.dirname(opts.globalConfigPath) : undefined;
      if (globalRoot) {
        const broadcastSessions = async () => {
          try {
            // Lazy import to avoid bundling core into the webui runtime
            const { SessionRegistry } = await import('@wrongstack/core');
            const registry = new SessionRegistry(globalRoot);
            const sessions = await registry.list();
            // Scope Fleet HQ to our own project (derive from our pid's entry —
            // survives in-place project switches). Fall back to all if not found.
            const mySlug = sessions.find((s) => s.pid === process.pid)?.projectSlug;
            const live = sessions
              .filter((s) => s.status !== 'stale')
              .filter((s) => (mySlug ? s.projectSlug === mySlug : true))
              .map((s) => ({
                sessionId: s.sessionId,
                projectName: s.projectName,
                projectSlug: s.projectSlug,
                projectRoot: s.projectRoot,
                workingDir: s.workingDir,
                gitBranch: s.gitBranch,
                clientType: s.clientType,
                status: s.status,
                pid: s.pid,
                startedAt: s.startedAt,
                agentCount: s.agentCount,
                agents: s.agents.map((a) => ({
                  id: a.id,
                  name: a.name,
                  status: a.status,
                  currentTool: a.currentTool,
                  iterations: a.iterations,
                  toolCalls: a.toolCalls,
                  costUsd: a.costUsd,
                  tokensIn: a.tokensIn,
                  tokensOut: a.tokensOut,
                  ctxPct: a.ctxPct,
                  model: a.model,
                  partialText: a.partialText,
                  lastActivityAt: a.lastActivityAt,
                })),
              }));
            broadcast({ type: 'sessions.status_update', payload: { sessions: live } });
          } catch {
            // Best-effort — never crash the WebSocket relay for status errors
          }
        };
        // Expose to the /api/fleet/ping HTTP route (push-on-write).
        fleetBroadcastCli = broadcastSessions;

        // Fallback poll (also prunes stale entries on read).
        const statusInterval = setInterval(() => void broadcastSessions(), 5_000);
        if (statusInterval.unref) statusInterval.unref();
        eventUnsubscribers.push(() => clearInterval(statusInterval));

        // Event-driven: watch the registry file so a TUI/REPL write reaches the
        // map in ~150ms. Atomic writes go `<file>.<uuid>.tmp`→rename → watch the
        // dir and match any `session-registry.json*` change (ignore .lock).
        let regDebounce: ReturnType<typeof setTimeout> | undefined;
        try {
          const regWatcher = fsWatch(globalRoot, { persistent: false }, (_event, filename) => {
            const name = filename ? String(filename) : '';
            if (!name.startsWith('session-registry.json') || name.endsWith('.lock')) return;
            if (regDebounce) clearTimeout(regDebounce);
            regDebounce = setTimeout(() => void broadcastSessions(), 150);
          });
          eventUnsubscribers.push(() => {
            if (regDebounce) clearTimeout(regDebounce);
            regWatcher.close();
          });
        } catch {
          // Watch unsupported on this platform — the 5s poll still covers it.
        }

        void broadcastSessions();
      }
    });

    wss.on('connection', async (ws, req) => {
      // Per-connection error handler, attached FIRST (before any awaited
      // work or even the auth check). Without it, a socket-level error —
      // most notably an oversized inbound frame (the `ws` receiver throws
      // `RangeError: Max payload size exceeded`, close 1009, once a client
      // sends more than `maxPayload`) — is emitted as an unhandled 'error'
      // on this socket and crashes the whole process. `wss.on('error')`
      // only catches SERVER-level errors, not per-connection ones.
      ws.on('error', (err) => {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'webui_server.client_socket_error',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      });

      // --- Auth: DNS-rebinding guard + token (cookie or URL) + loopback
      // bootstrap. Delegated to the shared `verifyClient` (ws-auth.ts) so the
      // embedded server enforces the SAME policy as the standalone one — most
      // importantly the HttpOnly `ws_token` cookie set by `/ws-auth`, and a
      // SINGLE token (`wsToken`).
      //
      // This used to be an inline check that (a) validated `?token=` against a
      // SECOND, unrelated `authToken` (never the `wsToken` that lands in the
      // URL / cookie / `/api/*`), and (b) ignored the cookie entirely. On
      // loopback the origin bootstrap masked the mismatch, but the cookie path
      // was dead and a LAN bind (`WS_HOST=0.0.0.0`) could never authenticate.
      const ok = verifyWsClient({
        origin: req.headers.origin,
        url: req.url ?? '/',
        hostHeader: req.headers.host,
        remoteAddress: req.socket.remoteAddress,
        cookieHeader: req.headers.cookie,
        wsHost: host,
        expectedToken: wsToken,
        requireToken,
        allowedHostnames: publicHostnames,
        allowBrowserUrlToken: Boolean(publicWsUrl),
      });
      if (!ok) {
        ws.close(4003, 'Forbidden');
        return;
      }

      const client: ConnectedClient = { ws, sessionId: currentSessionId() };
      clients.set(ws, client);

      // Register this client with the AutoPhase handler so it receives phase events
      autoPhaseHandler.addClient(ws);
      specsHandler.addClient(ws);
      sddBoardHandler.addClient(ws);
      sddWizardHandler?.addClient(ws);
      worktreeHandler.addClient(ws);

      // Per-connection rate limiting — disabled unless WEBUI_RATE_LIMIT > 0.
      let msgCount = 0;
      let windowResetAt = Date.now() + 60_000;

      ws.on('message', async (data) => {
        if (rateLimitMax > 0) {
          const now = Date.now();
          if (now > windowResetAt) {
            msgCount = 0;
            windowResetAt = now + 60_000;
          }
          if (++msgCount > rateLimitMax) {
            send(ws, {
              type: 'error',
              payload: sessionPayload({ phase: 'rate_limit', message: 'Too many messages. Please wait.' }),
            });
            return;
          }
        }
        try {
          const msg = JSON.parse(data.toString()) as WSClientMessage;
          await handleMessage(ws, client, msg);
        } catch (err) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'webui_server.message_parse_failed',
              message: err instanceof Error ? err.message : String(err),
              timestamp: new Date().toISOString(),
            }),
          );
        }
      });

      ws.on('close', () => {
        clients.delete(ws);
        // Drop this socket's in-flight run controller (if any). We do NOT
        // abort the run here — a tab close may be a reload, and the user
        // may reconnect. The controller is removed so a future
        // `case 'abort'` from a reconnected socket starts clean. The
        // `handleUserMessage` finally-block also clears its entry, so
        // this is a safety net for an unclean close mid-run.
        abortControllers.delete(ws);
        // If the last client leaves while a permission prompt is pending, deny
        // it so the agent loop doesn't hang waiting for an answer that will
        // never arrive (the terminal no longer prompts in --webui mode).
        if (clients.size === 0 && pendingConfirms.size > 0) {
          for (const [id, resolve] of pendingConfirms) {
            resolve('no');
            pendingConfirms.delete(id);
          }
        }
      });

      // Send session.start to the new client — per-model cost rates
      // and context-window cap so the frontend can compute accurate
      // live costs. The auth token is no longer in the payload: the
      // cookie path (`/ws-auth` → `Set-Cookie: ws_token=…`) is the
      // C-2 recommended delivery (Phase 1.4) and `?token=…` from
      // the server-printed URL is the back-compat fallback. Including
      // the token here would re-introduce the C-598 query-string
      // exposure class.
      const base = await buildSessionStartPayload({}, opts.needsSetup ?? false);
      send(ws, {
        type: 'session.start',
        payload: { ...base },
      });
    });

    wss.on('error', (err) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'webui_server.error',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    });

    // Graceful shutdown (extracted to webui-server/lifecycle.ts, PR 7 of
    // #30). Idempotent: every runWebUI call registers its own SIGINT/SIGTERM
    // handlers, so a signal after this server already stopped (multiple
    // servers per process — tests, /webui restarts) must not re-run teardown
    // or fire a second unregister against a gone registry. The teardown
    // sequence (abort in-flight runs → unsubscribe events → close clients →
    // unregister → close HTTP/WS → resolve) lives in lifecycle.ts; the
    // run-loop state stays here and is threaded in as callbacks.
    const signalShutdown = createWebuiShutdown({
      abortInFlight: () => {
        // Both the legacy single slot (project-switch path) and every
        // per-socket controller must be aborted — they are independent.
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
        for (const c of abortControllers.values()) c.abort();
        abortControllers.clear();
      },
      unsubscribeEvents: () => {
        flushAllStreamBuffers();
        for (const unsub of eventUnsubscribers) unsub();
      },
      closeClients: () => {
        for (const [ws] of clients) ws.close();
        clients.clear();
      },
      closeHttpServer: () => {
        httpServer?.server.close();
      },
      wss,
      pid: process.pid,
      registryBaseDir,
      onStopped: resolve,
    });

    registerWebuiSignalHandlers(signalShutdown);
  });

  // ── Message router ──────────────────────────────────────────────────
  // A declarative route table keyed by WSClientMessage['type']. Each entry
  // is a closure that captures the context objects in scope. Replaces the
  // former 112-case switch statement. Prefix-based handlers (autophase.*,
  // specs.*, sdd.*) fall through to the fallback chain in handleMessage().
  type WsRouteHandler = (msg: WSClientMessage, ws: WebSocket) => void | Promise<void>;
  const noop = () => {};
  const sessionBoundRouteTypes = new Set<string>([
    'user_message',
    'abort',
    'tool.confirm_result',
    'diag.get',
    'stats.get',
    'side_effects.list',
    'session.new',
    'session.resume',
    'session.save',
    'session.checkpoints',
    'session.rewind',
    'context.clear',
    'context.compact',
    'context.repair',
    'context.debug',
    'context.modes.list',
    'context.mode.switch',
    'context.mode.create',
    'context.mode.update',
    'context.mode.delete',
    'todos.get',
    'todos.clear',
    'todos.remove',
    'todo.update',
    'tasks.get',
    'task.update',
    'plan.get',
    'plan.template_use',
    'plan.item.update',
  ]);

  const requestedSessionId = (msg: WSClientMessage): string | undefined => {
    const payload = msg.payload;
    return payload && typeof payload === 'object' && typeof (payload as { sessionId?: unknown }).sessionId === 'string'
      ? (payload as { sessionId: string }).sessionId
      : undefined;
  };

  const ensureRouteSession = (ws: WebSocket, msg: WSClientMessage): boolean => {
    if (!sessionBoundRouteTypes.has(msg.type)) return true;
    const requested = requestedSessionId(msg);
    const current = currentSessionId();
    if (!requested || requested === current) return true;
    send(ws, {
      type: 'error',
      payload: sessionPayload({
        phase: msg.type,
        message: `Request targeted session ${requested}, but this WebUI runtime is currently on ${current}.`,
        requestedSessionId: requested,
      }),
    });
    return false;
  };

  const projectRootFor = () =>
    opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '';

  /** Validate an `auth.oauth.*` message's `kind` field. */
  const oauthKindOf = (msg: unknown): 'chatgpt' | 'claude' | 'copilot' | null => {
    const kind = (msg as { payload?: { kind?: unknown } })?.payload?.kind;
    return kind === 'chatgpt' || kind === 'claude' || kind === 'copilot' ? kind : null;
  };

  const wsRoutes: Record<string, WsRouteHandler> = {
    // ── Core connection ──
    user_message: (msg, ws) =>
      handleUserMessage(
        connectionCtx,
        ws,
        (msg as { payload: { content: string } }).payload.content,
        (msg as { payload?: { sessionId?: string } }).payload?.sessionId,
      ),
    abort: (msg, ws) =>
      handleAbort(connectionCtx, ws, (msg as { payload?: { sessionId?: string } }).payload?.sessionId),
    ping: (_msg, ws) => handlePing(connectionCtx, ws),
    'tool.confirm_result': (msg, _ws) => {
      const { id, decision } = (
        msg as { payload: { id: string; decision: 'yes' | 'no' | 'always' | 'deny'; sessionId?: string } }
      ).payload;
      handleToolConfirmResult(
        connectionCtx,
        id,
        decision,
        (msg as { payload: { sessionId?: string } }).payload.sessionId,
      );
    },
    'webui.shutdown': () => {
      console.log('[WebUI] Shutdown requested from client');
      shutdown();
    },

    // ── Providers / keys ──
    'providers.list': (_msg, ws) => handleProvidersList(wsHandlerCtx, ws),
    'provider.models': (msg, ws) =>
      handleProviderModels(
        wsHandlerCtx,
        ws,
        (msg as { payload: { providerId: string } }).payload.providerId,
      ),
    'providers.saved': (_msg, ws) => handleProvidersSaved(wsHandlerCtx, ws),
    'key.add': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string; apiKey: string } };
      handleKeyUpsert(wsHandlerCtx, ws, m.payload.providerId, m.payload.label, m.payload.apiKey);
    },
    'key.update': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string; apiKey: string } };
      handleKeyUpsert(wsHandlerCtx, ws, m.payload.providerId, m.payload.label, m.payload.apiKey);
    },
    'key.delete': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string } };
      handleKeyDelete(wsHandlerCtx, ws, m.payload.providerId, m.payload.label);
    },
    'key.set_active': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string } };
      handleKeySetActive(wsHandlerCtx, ws, m.payload.providerId, m.payload.label);
    },
    'provider.add': (msg, ws) =>
      handleProviderAdd(
        wsHandlerCtx,
        ws,
        (msg as { payload: { id: string; family: string; baseUrl?: string; apiKey?: string } })
          .payload,
      ),
    'provider.remove': (msg, ws) =>
      handleProviderRemove(
        wsHandlerCtx,
        ws,
        (msg as { payload: { providerId: string } }).payload.providerId,
      ),
    'provider.clear_models': (msg, ws) =>
      handleProviderClearModels(
        wsHandlerCtx,
        ws,
        (msg as { payload: { providerId: string } }).payload.providerId,
      ),
    'provider.undo_clear': (msg, ws) => {
      const m = msg as { payload: { providerId: string; previousModels: string[] } };
      handleProviderUndoClear(wsHandlerCtx, ws, m.payload.providerId, m.payload.previousModels);
    },
    'provider.update': (msg, ws) =>
      handleProviderUpdate(
        wsHandlerCtx,
        ws,
        (
          msg as {
            payload: {
              id: string;
              family?: string;
              baseUrl?: string;
              envVars?: string[];
              models?: string[];
            };
          }
        ).payload,
      ),
    'provider.probe': (msg, ws) => {
      const m = msg as { payload: { providerId: string; timeoutMs?: number } };
      handleProviderProbe(wsHandlerCtx, ws, m.payload.providerId, m.payload.timeoutMs);
    },

    // ── Subscription OAuth login (ChatGPT / Claude / Copilot) ──
    'auth.oauth.start': (msg, ws) => {
      const kind = oauthKindOf(msg);
      if (kind) void handleOAuthStart(wsHandlerCtx, ws, kind);
    },
    'auth.oauth.code': (msg, ws) => {
      const kind = oauthKindOf(msg);
      const input = (msg as { payload?: { input?: unknown } }).payload?.input;
      if (kind && typeof input === 'string' && input.trim()) {
        void handleOAuthCode(wsHandlerCtx, ws, kind, input);
      }
    },
    'auth.oauth.cancel': (msg, ws) => {
      const kind = oauthKindOf(msg);
      if (kind) handleOAuthCancel(wsHandlerCtx, ws, kind);
    },

    // ── Todos / goals / plans / tasks ──
    'todos.get': (_msg, ws) => handleTodosGet(worklistCtx, ws),
    'todos.clear': (_msg, ws) => handleTodosClear(worklistCtx, ws),
    'todos.remove': (msg, ws) =>
      handleTodosRemove(
        worklistCtx,
        ws,
        msg.payload as { id?: string; index?: number } | undefined,
      ),
    'todo.update': (msg, ws) =>
      handleTodoUpdate(
        worklistCtx,
        ws,
        msg.payload as { id: string; status?: TodoItem['status']; activeForm?: string },
      ),
    'goal.get': (_msg, ws) => handleGoalGet(sessionsCtx, ws),
    'plan.get': (_msg, ws) => handlePlanGet(worklistCtx, ws),
    'plan.template_use': (msg, ws) =>
      handlePlanTemplateUse(
        worklistCtx,
        ws,
        (msg as { payload: { template: string } }).payload.template,
      ),
    'plan.item.update': (msg, ws) =>
      handlePlanItemUpdate(
        worklistCtx,
        ws,
        msg.payload as { target: string; status: 'open' | 'in_progress' | 'done' },
      ),
    'tasks.get': (_msg, ws) => handleTasksGet(worklistCtx, ws),
    'task.update': (msg, ws) =>
      handleTaskUpdate(
        worklistCtx,
        ws,
        msg.payload as {
          id: string;
          status: 'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed';
        },
      ),

    // ── Sessions ──
    'sessions.list': (msg, ws) =>
      handleSessionsList(
        sessionsCtx,
        ws,
        (msg as { payload?: { limit?: number } }).payload?.limit ?? 50,
      ),
    'session.new': (_msg, ws) => handleSessionNew(sessionsCtx, ws),
    'session.delete': (msg, ws) =>
      handleSessionDelete(sessionsCtx, ws, (msg as { payload: { id: string } }).payload.id),
    'session.save': (_msg, ws) => handleSessionSave(sessionsCtx, ws),
    'session.resume': (msg, ws) =>
      handleSessionResume(sessionsCtx, ws, (msg as { payload: { id: string } }).payload.id),
    'session.checkpoints': (_msg, ws) => handleSessionCheckpoints(sessionsCtx, ws),
    'session.rewind': (msg, ws) =>
      handleSessionRewind(
        sessionsCtx,
        ws,
        (msg as { payload: { checkpointIndex: number } }).payload.checkpointIndex,
      ),

    // ── Context ──
    'context.clear': (_msg, ws) => handleContextClear(contextHandlerCtx, ws),
    'context.debug': (_msg, ws) => handleContextDebug(contextHandlerCtx, ws),
    'context.compact': (msg, ws) =>
      handleContextCompact(
        contextHandlerCtx,
        ws,
        !!(msg as { payload?: { aggressive?: boolean } }).payload?.aggressive,
      ),
    'context.repair': (_msg, ws) => handleContextRepair(contextHandlerCtx, ws),
    'context.modes.list': (_msg, ws) => handleContextModesList(contextHandlerCtx, ws),
    'context.mode.switch': (msg, ws) =>
      handleContextModeSwitch(
        contextHandlerCtx,
        ws,
        (msg as { payload: { id: string } }).payload.id,
      ),
    'context.mode.create': (msg, ws) =>
      handleContextModeCreate(
        contextHandlerCtx,
        ws,
        (
          msg as {
            payload: {
              id: string;
              name: string;
              description: string;
              thresholds: { warn: number; soft: number; hard: number };
              preserveK: number;
              eliseThreshold: number;
            };
          }
        ).payload,
      ),
    'context.mode.update': (msg, ws) =>
      handleContextModeUpdate(
        contextHandlerCtx,
        ws,
        (
          msg as {
            payload: {
              id: string;
              name?: string;
              description?: string;
              thresholds?: { warn?: number; soft?: number; hard?: number };
              preserveK?: number;
              eliseThreshold?: number;
            };
          }
        ).payload,
      ),
    'context.mode.delete': (msg, ws) =>
      handleContextModeDelete(
        contextHandlerCtx,
        ws,
        (msg as { payload: { id: string } }).payload.id,
      ),

    // ── Agent config: modes / models ──
    'modes.list': (_msg, ws) => handleModesList(agentConfigCtx, ws),
    'mode.switch': (msg, ws) =>
      handleModeSwitch(agentConfigCtx, ws, (msg as { payload: { id: string } }).payload.id),
    'model.switch': (msg, ws) =>
      handleModelSwitch(
        agentConfigCtx,
        ws,
        (msg as { payload: { provider: string; model: string } }).payload,
      ),
    'model.refine': (msg, ws) =>
      handleModelRefine(agentConfigCtx, ws, (msg as { payload: { text: string } }).payload.text),

    // ── Process management ──
    'process.list': (_msg, ws) => handleProcessList(wsCommon, ws),
    'process.kill': (msg, ws) =>
      handleProcessKill(wsCommon, ws, (msg as { payload: { pid: number } }).payload.pid),
    'process.killAll': (_msg, ws) => handleProcessKillAll(wsCommon, ws),

    // ── Diagnostics / introspection ──
    'diag.get': (_msg, ws) => handleDiagGet(introspectionCtx, ws),
    'stats.get': (_msg, ws) => handleStatsGet(introspectionCtx, ws),
    'side_effects.list': (_msg, ws) => {
      const sideEffects = opts.agent.ctx.sideEffects ?? [];
      send(ws, {
        type: 'side_effects',
        payload: sessionPayload({
          sideEffects: sideEffects.slice(-50).map((se) => ({
            toolUseId: se.toolUseId,
            toolName: se.toolName,
            ts: se.ts,
            input: se.input,
            outcome: se.outcome,
            risk: se.risk,
          })),
        }),
      });
    },
    'tools.list': (_msg, ws) => handleToolsList(introspectionCtx, ws),

    // ── Autonomy ──
    'autonomy.switch': (msg, ws) =>
      handleAutonomySwitch(prefsCtx, ws, (msg as { payload: { mode: string } }).payload.mode),

    // ── Brain ──
    'brain.status': (_msg, ws) => handleBrainStatus(brainCtx, ws),
    'brain.risk': (msg, ws) =>
      handleBrainRisk(brainCtx, ws, (msg as { payload?: { level?: string } }).payload?.level ?? ''),
    'brain.ask': (msg, ws) =>
      handleBrainAsk(brainCtx, ws, (msg as { payload?: { question?: string } }).payload?.question),

    // ── Preferences ──
    'prefs.get': (_msg, ws) => handlePrefsGet(prefsCtx, ws),
    'prefs.update': (msg, ws) =>
      handlePrefsUpdate(prefsCtx, ws, (msg as { payload: Record<string, unknown> }).payload),

    // ── File operations (delegated to shared file-handlers.ts) ──
    'files.list': (msg, ws) => handleFilesList(ws, msg, projectRootFor()),
    'files.tree': (msg, ws) => handleFilesTree(ws, msg, projectRootFor()),
    'files.read': (msg, ws) => handleFilesRead(ws, msg, projectRootFor()),
    'files.write': (msg, ws) => handleFilesWrite(ws, msg, projectRootFor()),
    'completion.request': (msg, ws) =>
      handleCompletionRequest(ws, msg, {
        projectRoot: projectRootFor(),
        provider: opts.agent.ctx.provider,
        model: opts.agent.ctx.model,
        indexDir:
          typeof opts.agent.ctx.meta['codebaseIndexDir'] === 'string'
            ? opts.agent.ctx.meta['codebaseIndexDir']
            : undefined,
        lspCompletion: createToolLspCompletionSource(
          opts.agent.ctx.tools.find((tool) => tool.name === 'lsp_completion'),
          opts.agent.ctx,
        ),
      }),

    // ── Memory (guarded — opts.memoryStore may be undefined) ──
    'memory.list': (_msg, ws) => {
      if (!opts.memoryStore) {
        send(ws, {
          type: 'memory.list',
          payload: { text: '', error: 'Memory store not available' },
        });
        return;
      }
      return handleMemoryList(ws, opts.memoryStore);
    },
    'memory.remember': (msg, ws) => {
      if (!opts.memoryStore) {
        sendResult(ws, false, 'Memory store not available');
        return;
      }
      return handleMemoryRemember(ws, msg, opts.memoryStore);
    },
    'memory.forget': (msg, ws) => {
      if (!opts.memoryStore) {
        sendResult(ws, false, 'Memory store not available');
        return;
      }
      return handleMemoryForget(ws, msg, opts.memoryStore);
    },

    // ── MCP operations (shared handlers from @wrongstack/webui/server) ──
    'mcp.list': (msg, ws) => handleMcpList(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.add': (msg, ws) => handleMcpAdd(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.remove': (msg, ws) =>
      handleMcpRemove(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.update': (msg, ws) =>
      handleMcpUpdate(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.wake': (msg, ws) => handleMcpWake(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.sleep': (msg, ws) =>
      handleMcpSleep(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.discover': (msg, ws) =>
      handleMcpDiscover(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.enable': (msg, ws) =>
      handleMcpEnable(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.disable': (msg, ws) =>
      handleMcpDisable(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.restart': (msg, ws) =>
      handleMcpRestart(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),

    // ── Skills ──
    'skills.list': (_msg, ws) => handleSkillsList(introspectionCtx, ws),
    'skills.content': (msg, ws) => handleSkillsContent(ws, skillsCtx, msg),
    'skills.install': (msg, ws) => handleSkillsInstall(ws, skillsCtx, msg),
    'skills.uninstall': (msg, ws) => handleSkillsUninstall(ws, skillsCtx, msg),
    'skills.update': (msg, ws) => handleSkillsUpdate(ws, skillsCtx, msg),
    'skills.create': (msg, ws) => handleSkillsCreate(ws, skillsCtx, msg),
    'skills.edit': (msg, ws) => handleSkillsEdit(ws, skillsCtx, msg),
    'skills.export': (_msg, ws) => handleSkillsExport(ws, skillsCtx),

    // ── Prompt library ──
    'prompts.list': (_msg, ws) => handlePromptsList(ws, promptsCtx),
    'prompts.search': (msg, ws) => handlePromptsSearch(ws, promptsCtx, msg),
    'prompts.content': (msg, ws) => handlePromptsContent(ws, promptsCtx, msg),
    'prompts.favorite': (msg, ws) => handlePromptsFavorite(ws, promptsCtx, msg),
    'prompts.create': (msg, ws) => handlePromptsCreate(ws, promptsCtx, msg),
    'prompts.used': (msg, ws) => handlePromptsUsed(ws, promptsCtx, msg),
    'prompts.recent': (_msg, ws) => handlePromptsRecent(ws, promptsCtx),

    // ── Design Studio ──
    'design.list': (_msg, ws) => handleDesignList(ws, designCtx),
    'design.use': (msg, ws) => handleDesignUse(ws, designCtx, msg),
    'design.state': (_msg, ws) => handleDesignState(ws, designCtx),
    'design.set': (msg, ws) => handleDesignSet(ws, designCtx, msg),
    'design.materialize': (msg, ws) => handleDesignMaterialize(ws, designCtx, msg),
    'design.verify': (_msg, ws) => handleDesignVerify(ws, designCtx),

    // ── Projects / working dir ──
    'projects.list': (_msg, ws) => handleProjectsList(projectsCtx, ws),
    'projects.select': (msg, ws) =>
      handleProjectsSelect(
        projectsCtx,
        ws,
        (msg as { payload: { root: string; name?: string } }).payload,
      ),
    'projects.add': (msg, ws) =>
      handleProjectsAdd(
        projectsCtx,
        ws,
        (msg as { payload: { root: string; name?: string } }).payload,
      ),
    'working_dir.set': (msg, ws) =>
      handleWorkingDirSet(projectsCtx, ws, (msg as { payload: { path: string } }).payload.path),

    // ── Git ──
    'git.changes': (_msg, ws) => handleGitChanges(ws, projectRootFor()),
    'git.diff': (msg, ws) =>
      handleGitDiff(
        ws,
        projectRootFor(),
        (msg as { payload?: { path?: string } }).payload?.path ?? '',
      ),
    'git.info': (_msg, ws) => handleGitInfo(ws, projectRootFor()),

    // ── Shell ──
    'shell.open': async (msg, ws) => {
      const result = await handleShellOpen(
        msg.payload as Parameters<typeof handleShellOpen>[0],
        consoleLogger,
      );
      sendResult(ws, result.success, result.message);
    },

    // ── Mailbox ──
    'mailbox.messages': (msg, ws) =>
      handleMailboxMessages(mailboxCtx, msg as Parameters<typeof handleMailboxMessages>[1], ws),
    'mailbox.agents': (msg, ws) =>
      handleMailboxAgents(mailboxCtx, msg as Parameters<typeof handleMailboxAgents>[1], ws),
    'mailbox.clear': (_msg, ws) => handleMailboxClear(mailboxCtx, ws),
    'mailbox.purge': (msg, ws) =>
      handleMailboxPurge(mailboxCtx, msg as Parameters<typeof handleMailboxPurge>[1], ws),

    // ── Silent no-ops (standalone server wires real handlers) ──
    'collab.join': noop,
    'collab.leave': noop,
    'collab.annotate': noop,
    'collab.resolve': noop,
    'collab.request_pause': noop,
    'collab.resume': noop,
    'collab.grant_control': noop,
    'collab.inject_tool': noop,
    'terminal.create': noop,
    'terminal.input': noop,
    'terminal.resize': noop,
    'terminal.close': noop,
  };

  async function handleMessage(
    ws: WebSocket,
    _client: ConnectedClient,
    msg: WSClientMessage,
  ): Promise<void> {
    if (!ensureRouteSession(ws, msg)) return;
    const handler = wsRoutes[msg.type];
    if (handler) {
      await handler(msg, ws);
      return;
    }
    // ── Prefix-based fallback for delegated handlers ──
    const msgType = (msg as { type: string }).type;
    if (msgType.startsWith('autophase.')) {
      await autoPhaseHandler.handleMessage(
        msg as { type: string; payload?: Record<string, unknown> },
      );
    } else if (msgType.startsWith('specs.')) {
      await specsHandler.handleMessage(msg as { type: string; payload?: Record<string, unknown> });
    } else if (msgType.startsWith('sdd.board.')) {
      await sddBoardHandler.handleMessage(
        msg as { type: string; payload?: Record<string, unknown> },
      );
    } else if (msgType.startsWith('sdd.spec.') || msgType.startsWith('sdd.run.')) {
      await sddWizardHandler?.handleMessage(
        msg as { type: string; payload?: Record<string, unknown> },
      );
    } else if (msgType.startsWith('worktree.')) {
      await worktreeHandler.handleMessage(msg as { type: string; payload?: Record<string, unknown> });
    } else {
      console.debug(`[WebUI] Unhandled message type: ${msgType}`);
    }
  }

  function send(ws: WebSocket, msg: WSServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function shutdown(): void {
    console.log('[WebUI] Shutting down...');
    credentialWatcherClose?.();
    flushAllStreamBuffers();
    worktreeHandler.dispose();
    unregisterWebuiClient();
    httpServer?.server.close();
    opts.onExit?.();
  }

  function broadcast(msg: WSServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws] of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data);
        } catch {
          // Client disconnected between the readyState check and the send
          // — let the 'close' handler remove it from the map naturally.
        }
      }
    }
  }

  // ---- Config I/O helpers (delegated to webui-server/provider-config) ----

  function sendResult(ws: WebSocket, success: boolean, message: string): void {
    send(ws, { type: 'key.operation_result', payload: { success, message } });
  }

  return stopped;
} // end of runWebUI
