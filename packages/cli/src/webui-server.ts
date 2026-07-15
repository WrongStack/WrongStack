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
 *   webui-server/stream-coalescer.ts   — server-side coalescing of
 *                                        text/thinking deltas + tool
 *                                        progress (PR 9)
 *   webui-server/client-registration.ts — mailbox presence + HQ telemetry
 *                                        heartbeat for this instance (PR 10)
 *   webui-server/session-start-payload.ts — session.start payload builder
 *                                        with cost rates + max context (PR 11)
 *
 * `handleMessage` now only routes: each case unpacks the payload and calls
 * the matching `handleXxx(ctx, …)`. The per-group contexts are all built
 * once (before the WS connection handler is wired, so a fast client message
 * can't reach a handler before its context initializes). The file/memory/
 * mailbox/shell cases delegate to the shared `@wrongstack/webui-server`
 * handlers.
 *
 * Public surface: `runWebUI` plus the `WSServerMessage` / `WSClientMessage`
 * message shapes. Everything else is internal to the run.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  DefaultSecretScrubber,
  PromptUsageStore,
  resolveWstackPaths,
  TOKENS,
  watchProviderConfig,
  wstackGlobalRoot,
} from '@wrongstack/core';
import { SkillInstaller } from '@wrongstack/core/skills';
import { toErrorMessage } from '@wrongstack/core/utils/error';
import type { MCPRegistry } from '@wrongstack/mcp';
import { makeProviderFromConfig } from '@wrongstack/providers';
import { createKanbanRunMirror } from './webui-server/kanban-run-mirror.js';
import { createKanbanSupervisor } from './webui-server/kanban-supervisor.js';
import {
  AutoPhaseWebSocketHandler,
  buildSddWizardDeps,
  buildWebUIAccessUrl,
  type CustomModeStore,
  createCustomModeStore,
  type DesignContext,
  envFlag,
  findFreePort,
  type PromptsContext,
  resolveAuthToken,
  SddBoardWebSocketHandler,
  SddWizardWebSocketHandler,
  type SkillsContext,
  SpecsWebSocketHandler,
  TerminalWebSocketHandler,
  WorktreeWebSocketHandler,
} from '@wrongstack/webui-server';
import { WebSocket, WebSocketServer } from 'ws';
import { createWebuiClientRegistration } from './webui-server/client-registration.js';
import {
  type ConnectedClient,
  createConnectionHandler,
} from './webui-server/connection-handler.js';
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
import { createMessageRouter } from './webui-server/message-router.js';
// PR 8 of Issue #30: extracted to `./webui-server/prefs-seeding.js`.
import { createPrefsSeeding, seedConfigToMeta } from './webui-server/prefs-seeding.js';
import { createProviderConfigStore, getVault } from './webui-server/provider-config.js';
import { createSessionStartPayloadBuilder } from './webui-server/session-start-payload.js';
import { startSessionStatusPoll } from './webui-server/session-status-poll.js';
import { createSetupEvents } from './webui-server/setup-events.js';
import { startStaticServe } from './webui-server/static-serve.js';
import { createStreamCoalescer } from './webui-server/stream-coalescer.js';
import {
  type AgentConfigContext,
  type BrainHandlerContext,
  broadcastSaved,
  type ConnectionContext,
  type ContextHandlerContext,
  type IntrospectionContext,
  type MailboxContext,
  type PendingConfirm,
  type PrefsContext,
  type ProjectsContext,
  type SessionsContext,
  type WorklistContext,
  type WsCommon,
  type WsHandlerContext,
} from './webui-server/ws-handlers/index.js';

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
  agent: Agent;
  events: EventBus;
  session: SessionWriter;
  /** WebSocket backend port. Defaults to 3457 (auto-advances if taken). */
  port?: number | undefined;
  /** Host/interface to bind HTTP and WS servers. Defaults to 127.0.0.1. */
  host?: string | undefined;
  /** HTTP port serving the React frontend. Defaults to 3456 (auto-advances). */
  httpPort?: number | undefined;
  /** Alternate frontend dist directory (used by the independent SimpleUI surface). */
  frontendDistDir?: string | undefined;
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
  sddSubagentFactory?: import('@wrongstack/core').AgentFactory | undefined;
  /** Session store — enables session.resume and session.delete from the WebUI. */
  sessionStore?: SessionStore | undefined;
  /** Host Brain arbiter (same instance bound at TOKENS.BrainArbiter). */
  brain?: BrainArbiter | undefined;
  /** Host brain settings — the SAME object /brain mutates (shared ceiling + mode). */
  brainSettings?:
    | {
        maxAutoRisk: BrainAutoRisk;
        mode?: import('@wrongstack/core').BrainEscalationMode | undefined;
        poolLabels?: string[] | undefined;
        councilLabels?: string[] | undefined;
      }
    | undefined;
  /** Live-editable Brain config owner (brain.config.get/set handlers). */
  brainRuntime?: import('@wrongstack/core').BrainRuntime | undefined;
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
  /** Forward browser YOLO changes to the host's live permission policy. */
  onYoloSwitch?: ((enabled: boolean) => void) | undefined;
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
  const globalRoot = opts.globalConfigPath
    ? path.dirname(opts.globalConfigPath)
    : wstackGlobalRoot();
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
  const pendingConfirms = new Map<string, PendingConfirm>();
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
      const store = createCustomModeStore(globalRoot);
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
  // KanbanRunMirror — projects live SDD (via the shared bus) and AutoPhase (via
  // the handler callback below) runs into kanban boards, so the kanban view is
  // the unified live surface. Needs a project root (kanban boards are project-scoped).
  const kanbanRunMirror = opts.projectRoot
    ? createKanbanRunMirror({
        projectRoot: opts.projectRoot,
        events: opts.events,
        broadcast,
        log: (m) => consoleLogger.info(m),
      })
    : null;
  const kanbanSupervisor = opts.projectRoot
    ? createKanbanSupervisor({
        projectRoot: opts.projectRoot,
        broadcast,
        ...(opts.onKanbanDispatch ? { dispatchTask: opts.onKanbanDispatch } : {}),
        log: (message) => consoleLogger.info(message),
      })
    : null;
  const autoPhaseHandler = new AutoPhaseWebSocketHandler(
    opts.agent,
    opts.agent.ctx as Context,
    consoleLogger,
    autoPhaseStoreDir,
    opts.events,
    opts.projectRoot,
    kanbanRunMirror
      ? (graphId, state) => kanbanRunMirror.onAutophaseState(graphId, state)
      : undefined,
  );
  const worktreeHandler = new WorktreeWebSocketHandler(opts.events, consoleLogger);

  // Integrated terminal — the shared per-client node-pty transport. node-pty
  // is an optional dependency of @wrongstack/webui (where the prebuilds
  // live), so under pnpm it is NOT resolvable from the handler's own module
  // — resolve it through the webui package instead and hand the loader in.
  //
  // Three resolution strategies, in order:
  //   1. `@wrongstack/webui/package.json` via createRequire — this gives a
  //      filesystem path to webui's package dir, then we walk into its
  //      `node_modules/node-pty` symlink. Avoids `ERR_PACKAGE_PATH_NOT_EXPORTED`
  //      (Node 16+ refuses `./package.json` subpath unless the package's
  //      `exports` field lists it).
  //   2. Direct `require('node-pty')` from the CLI's own resolution root
  //      (works when node-pty is hoisted or symlinked into cli's deps).
  //   3. Workspace-root `node_modules/node-pty` (the pnpm `.pnpm/node-pty@*`
  //      store path resolved via the monorepo's workspace root).
  const requireFromCli = createRequire(import.meta.url);
  let cachedNodePty: unknown;
  const loadNodePtyViaWebui = () => {
    if (cachedNodePty !== undefined) return cachedNodePty as never;
    // Strategy 1: resolve webui via its main export, then walk to package.json.
    try {
      const webuiEntry = requireFromCli.resolve('@wrongstack/webui');
      // webuiEntry is the dist path (e.g. dist/index.js). Walk up to package.json.
      const webuiDir = webuiEntry.replace(/[\\/]dist.*$/, '');
      const webuiPkgJson = path.join(webuiDir, 'package.json');
      cachedNodePty = createRequire(webuiPkgJson)('node-pty');
      if (cachedNodePty) {
        consoleLogger.debug?.(`[terminal] node-pty loaded via webui package (${webuiDir})`);
        return cachedNodePty as never;
      }
    } catch (err) {
      consoleLogger.debug?.(`[terminal] webui-route failed: ${(err as Error).message}`);
    }
    // Strategy 2: direct require from CLI's own resolution root.
    try {
      cachedNodePty = requireFromCli('node-pty');
      consoleLogger.debug?.('[terminal] node-pty loaded via direct requireFromCli');
      return cachedNodePty as never;
    } catch (err) {
      consoleLogger.debug?.(`[terminal] direct require failed: ${(err as Error).message}`);
    }
    // Strategy 3: workspace root node_modules/node-pty.
    try {
      // @wrongstack/cli is the package we're currently inside; use
      // import.meta.url to find our own package.json (avoids the same
      // ERR_PACKAGE_PATH_NOT_EXPORTED issue the webui route had).
      const cliPkgJson = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
      let dir = path.dirname(cliPkgJson);
      for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, 'node_modules', 'node-pty');
        if (existsSync(candidate)) {
          cachedNodePty = createRequire(candidate)('node-pty');
          if (cachedNodePty) {
            consoleLogger.debug?.(`[terminal] node-pty loaded via workspace root (${candidate})`);
            return cachedNodePty as never;
          }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch (err) {
      consoleLogger.debug?.(`[terminal] workspace-root walk failed: ${(err as Error).message}`);
    }
    cachedNodePty = null;
    consoleLogger.debug?.('[terminal] node-pty resolution failed; terminal panel will report "unavailable"');
    return cachedNodePty as never;
  };
  const terminalHandler = new TerminalWebSocketHandler(
    () => (opts.agent.ctx as Context).cwd ?? opts.projectRoot ?? process.cwd(),
    consoleLogger,
    loadNodePtyViaWebui as ConstructorParameters<typeof TerminalWebSocketHandler>[2],
  );

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
  if (typeof opts.agent.ctx?.meta?.['yolo'] === 'boolean') {
    opts.onYoloSwitch?.(opts.agent.ctx.meta['yolo']);
  }

  const { prefSnapshot, persistPrefs } = createPrefsSeeding(opts);

  // Captured once at startup so stats.get can report elapsed time since the
  // session was opened, rather than the hardcoded 0 it used to send.
  const sessionStartedAt = Date.now();

  // session.start payload builder — cost rates + max-context enrichment.
  // PR 11 of Issue #30: extracted to `./webui-server/session-start-payload.ts`.
  const buildSessionStartPayload = createSessionStartPayloadBuilder(opts);

  // ── Client (REPL/TUI/WebUI) registration ─────────────────────────────────
  // Mailbox presence + HQ telemetry for this WebUI instance. PR 10 of
  // Issue #30: extracted to `./webui-server/client-registration.ts`.
  const { register: registerWebuiClient, unregister: unregisterWebuiClient } =
    createWebuiClientRegistration({
      projectRoot: opts.projectRoot,
      appConfig: opts.appConfig,
      events: opts.events,
      hqSessionId: opts.session.id,
      getSessionId: () => opts.agent.ctx.session?.id ?? opts.session.id,
      // Two-way HQ control for the WebUI client: steer/btw/queue/broadcast
      // land in the project mailbox (the WebUI's agent reads it like any
      // other surface), and abort tears down every in-flight run on this
      // instance. Without this block the WebUI would be HQ-invisible to the
      // Control tab — telemetry only.
      hqControl: {
        interruptLeader: () => {
          let aborted = false;
          if (abortController) {
            abortController.abort();
            abortController = null;
            aborted = true;
          }
          for (const c of abortControllers.values()) {
            c.abort();
            aborted = true;
          }
          abortControllers.clear();
          return aborted;
        },
        allowRunCommand: () => opts.hqAllowExec === true,
      },
    });

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

  // 20 MiB to leave headroom for image attachments (base64-inflated) in
  // user_message payloads. Keep in sync with webui-server's WS_MAX_PAYLOAD —
  // both servers speak the same protocol and must accept the same messages.
  const wss = new WebSocketServer({ port, host, maxPayload: 20 * 1024 * 1024 });

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
    globalRoot,
    distDir: opts.frontendDistDir,
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
  const registryBaseDir = globalRoot;
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

  const currentSessionId = (): string => opts.agent.ctx.session?.id ?? opts.session.id;
  const sessionPayload = <T extends Record<string, unknown>>(
    payload: T,
  ): T & { sessionId: string } => {
    const provided = payload['sessionId'];
    const sessionId =
      typeof provided === 'string' && provided.length > 0 ? provided : currentSessionId();
    return { ...payload, sessionId };
  };

  // Coalesce high-volume live events on the server before they hit every
  // connected browser tab. PR 9 of Issue #30: extracted to
  // `./webui-server/stream-coalescer.ts`.
  const {
    queueTextDelta,
    queueThinkingDelta,
    queueToolProgress,
    flushThinkingDelta,
    flushAllStreamBuffers,
  } = createStreamCoalescer({ broadcast, sessionPayload });

  // ── Event arming ─────────────────────────────────────────────────────────
  // Every EventBus → browser broadcast subscription (incl. the fleet
  // concurrency gauge state). PR 12 of Issue #30: extracted to
  // `./webui-server/setup-events.ts`.
  const setupEvents = createSetupEvents({
    events: opts.events,
    agent: opts.agent,
    subscribeEternalIteration: opts.subscribeEternalIteration,
    broadcast,
    sessionPayload,
    currentSessionId,
    queueTextDelta,
    queueThinkingDelta,
    queueToolProgress,
    flushThinkingDelta,
    flushAllStreamBuffers,
    pendingConfirms,
    secretScrubber,
    getClients: () => clients,
    eventUnsubscribers,
  });

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
    let lastUiLocale = opts.appConfig?.uiLocale;
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
            if (snapshot.uiLocale) opts.appConfig.uiLocale = snapshot.uiLocale;
          }
        } catch {
          /* frozen / read-only appConfig — ignore */
        }
        broadcastSaved(wsHandlerCtx, snapshot.providers);

        // Display language live-propagation: when another surface writes
        // Config.uiLocale (desktop shell, standalone WebUI, or another
        // embedded WebUI), push it through the same prefs path the frontend
        // already uses for instant i18n re-render.
        if (snapshot.uiLocale !== lastUiLocale) {
          lastUiLocale = snapshot.uiLocale;
          if (snapshot.uiLocale) {
            opts.agent.ctx.meta['uiLocale'] = snapshot.uiLocale;
            broadcast({ type: 'prefs.updated', payload: { uiLocale: snapshot.uiLocale } });
          }
        }

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
      {
        warn: (m) =>
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'webui.config_watcher',
              message: m,
              timestamp: new Date().toISOString(),
            }),
          ),
      },
    );
    credentialWatcherClose = watcher.close;
  }

  const brainCtx: BrainHandlerContext = {
    brainSettings: opts.brainSettings,
    brainRuntime: opts.brainRuntime,
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
    configStore: opts.agent.container?.safeResolve?.(TOKENS.ConfigStore),
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
  const skillsPaths = skillsProjectRoot
    ? resolveWstackPaths({
        projectRoot: skillsProjectRoot,
        globalRoot,
      })
    : undefined;
  const skillsCtx: SkillsContext = {
    skillLoader: opts.skillLoader,
    skillInstaller: opts.skillLoader
      ? new SkillInstaller({
          manifestPath: path.join(
            skillsPaths?.globalRoot ?? wstackGlobalRoot(),
            'installed-skills.json',
          ),
          projectSkillsDir:
            skillsPaths?.inProjectSkills ?? path.join(skillsProjectRoot, '.wrongstack', 'skills'),
          globalSkillsDir: skillsPaths?.globalSkills ?? path.join(wstackGlobalRoot(), 'skills'),
          projectHash: skillsPaths?.projectHash ?? '',
          skillLoader: opts.skillLoader,
        })
      : undefined,
    projectRoot: skillsProjectRoot,
    projectSkillsDir: skillsPaths?.inProjectSkills,
    globalSkillsDir: skillsPaths?.globalSkills,
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
    onYoloSwitch: opts.onYoloSwitch,
    onAutonomySwitch: opts.onAutonomySwitch,
    pendingConfirms,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  // Project add/select are disabled in WebUI; `opts` remains shared because
  // projects.list and working_dir.set still read the live project root/config.
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
  // ── Message router ──────────────────────────────────────────────────
  // Declarative route table + prefix fallback for delegated handlers. PR 15
  // of Issue #30: extracted to `./webui-server/message-router.ts`.
  const handleMessage = createMessageRouter({
    opts,
    send,
    sendResult,
    sessionPayload,
    currentSessionId,
    shutdown,
    wsHandlerCtx,
    brainCtx,
    introspectionCtx,
    skillsCtx,
    promptsCtx,
    designCtx,
    worklistCtx,
    agentConfigCtx,
    prefsCtx,
    projectsCtx,
    contextHandlerCtx,
    wsCommon,
    mailboxCtx,
    sessionsCtx,
    connectionCtx,
    autoPhaseHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    worktreeHandler,
    terminalHandler,
    kanbanRunMirror: kanbanRunMirror ?? undefined,
    kanbanSupervisor: kanbanSupervisor ?? undefined,
  });

  const stopped = new Promise<void>((resolve) => {
    wss.on('listening', () => {
      console.log(`[WebUI] WebSocket server running on ws://${host}:${port}`);
      setupEvents();
      opts.onListening?.({ httpPort, wsPort, host, url: accessUrl });

      // ── Live session status poll ──────────────────────────────────
      // Cross-process SessionRegistry → sessions.status_update broadcasts
      // (5s fallback poll + fs.watch push). PR 13 of Issue #30: extracted
      // to `./webui-server/session-status-poll.ts`.
      if (globalRoot) {
        startSessionStatusPoll({
          globalRoot,
          broadcast,
          eventUnsubscribers,
          onBroadcastReady: (fn) => {
            fleetBroadcastCli = fn;
          },
        });
      }
    });

    // WebSocket connection handler — per-tab error handling, auth, client
    // registration, rate limiting, message dispatch, close cleanup, and the
    // initial session.start push. PR 14 of Issue #30: extracted to
    // `./webui-server/connection-handler.ts`.
    wss.on(
      'connection',
      createConnectionHandler({
        host,
        wsToken,
        requireToken,
        publicHostnames,
        publicWsUrl,
        clients,
        currentSessionId,
        autoPhaseHandler,
        specsHandler,
        sddBoardHandler,
        sddWizardHandler,
        worktreeHandler,
        terminalHandler,
        rateLimitMax,
        send,
        sessionPayload,
        handleMessage,
        abortControllers,
        pendingConfirms,
        buildSessionStartPayload,
        loadReplay: async () => {
          const activeSession = opts.agent.ctx.session ?? opts.session;
          await activeSession.flush().catch(() => undefined);
          if (opts.sessionStore) {
            const data = await opts.sessionStore.load(activeSession.id);
            return { messages: data.messages, usage: data.usage };
          }
          const usage = opts.agent.ctx.tokenCounter.total();
          return { messages: opts.agent.ctx.messages, usage };
        },
        needsSetup: opts.needsSetup ?? false,
      }),
    );

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
    terminalHandler.dispose();
    kanbanRunMirror?.dispose();
    kanbanSupervisor?.dispose();
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
