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
 *   webui-server/ws-handlers/          — provider/model/key WS handlers,
 *                                        threaded via WsHandlerContext (PR 5)
 *   webui-server/lifecycle.ts          — instance registry, ready banner +
 *                                        open-browser, SIGINT/SIGTERM
 *                                        graceful shutdown (PR 7)
 *
 * The remaining `handleMessage` switch (sessions, todos, context, brain,
 * tasks, projects, plan, skills, modes, model, …) is still inline here:
 * those cases are coupled to ~25 pieces of run-loop state and have no
 * standalone unit coverage, so they await a dedicated test-first
 * extraction rather than being moved opportunistically. The file/memory/
 * mailbox/shell cases already delegate to the shared
 * `@wrongstack/webui/server` handlers.
 *
 * Public surface: `runWebUI` plus the `WSServerMessage` / `WSClientMessage`
 * message shapes. Everything else is internal to the run.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
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
  SessionStore,
  SessionWriter,
  SkillLoader,
} from '@wrongstack/core';
import {
  atomicWrite,
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  DefaultSecretScrubber,
  DefaultSystemPromptBuilder,
  enhanceUserPrompt,
  GlobalMailbox,
  mutatePlan,
  mutateTasks,
  projectSlug,
  recentTextTurns,
  repairToolUseAdjacency,
  resolveContextWindowPolicy,
  resolveProjectDir,
  setPlanItemStatus,
  TOKENS,
  type TodoItem,
  wstackGlobalRoot,
} from '@wrongstack/core';
import {
  DefaultSecretVault,
  decryptConfigSecrets,
  encryptConfigSecrets,
} from '@wrongstack/core/security';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import {
  AutoPhaseWebSocketHandler,
  type CustomModeStore,
  createCustomModeStore,
  createEternalSubscription,
  findFreePort,
  handleFilesList,
  handleFilesRead,
  handleFilesTree,
  handleFilesWrite,
  handleMemoryForget,
  handleMemoryList,
  handleMemoryRemember,
  handleShellOpen,
} from '@wrongstack/webui/server';
import {
  announceWebuiReady,
  createWebuiShutdown,
  registerWebuiInstance,
  registerWebuiSignalHandlers,
} from './webui-server/lifecycle.js';
import { createProviderConfigStore } from './webui-server/provider-config.js';
import { startStaticServe } from './webui-server/static-serve.js';
import {
  type BrainHandlerContext,
  type WsHandlerContext,
  handleBrainAsk,
  handleBrainRisk,
  handleBrainStatus,
  handleKeyDelete,
  handleKeySetActive,
  handleKeyUpsert,
  handleProviderAdd,
  handleProviderModels,
  handleProviderRemove,
  handleProvidersList,
  handleProvidersSaved,
} from './webui-server/ws-handlers/index.js';
import { WebSocket, WebSocketServer } from 'ws';
import { expectDefined } from './provider-config-utils.js';

// ── Console logger adapter for AutoPhaseWebSocketHandler ──────────────────────
// AutoPhaseWebSocketHandler requires a Logger. The CLI uses console.log/error
// directly, so we adapt that to the Logger interface expected by the handler.
// PR 1 of Issue #30: extracted to `./webui-server/logger-shim.js`.
import { consoleLogger } from './webui-server/logger-shim.js';

// PR 3 of Issue #30: extracted to `./webui-server/context-breakdown.js`.
import { estimateContextBreakdown } from './webui-server/context-breakdown.js';
type PromptBlock = import('./webui-server/context-breakdown.js').PromptBlock;
type ToolLike = import('./webui-server/context-breakdown.js').ToolLike;
type MessageLike = import('./webui-server/context-breakdown.js').MessageLike;

// ── Cost computation helpers (inlined from @wrongstack/webui/server/usage-cost.ts) ──
// PR 2 of Issue #30: extracted to `./webui-server/cost-helpers.js`.
import { getCostRates, computeUsageCost } from './webui-server/cost-helpers.js';

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
  /** HTTP port serving the React frontend. Defaults to 3456 (auto-advances). */
  httpPort?: number | undefined;
  /** Project root — recorded in the running-instance registry. */
  projectRoot?: string | undefined;
  /** Pop the browser open to the served URL once the frontend is ready. */
  open?: boolean | undefined;
  /**
   * Fired once the WebSocket server is accepting connections. Useful for
   * callers (and tests) that must not connect before the server is ready —
   * port resolution now makes startup asynchronous, so a synchronous bind can
   * no longer be assumed.
   */
  onListening?: (info: { httpPort: number; wsPort: number; host: string }) => void;
  modelsRegistry?: ModelsRegistry | undefined;
  globalConfigPath?: string | undefined;
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
  /** Mode store — enables the ModePicker (modes.list, mode.switch). */
  modeStore?: ModeStore | undefined;
  /** Active agent mode id passed to the frontend via session.start. */
  modeId?: string | undefined;
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
  const host = '127.0.0.1';
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

  // ── Settings parity with the TUI ─────────────────────────────────────
  // The browser settings panel reads prefs via `prefs.get` → context.meta.
  // Seed the meta from config.json so the panel shows the REAL persisted
  // values (otherwise every browser shows its localStorage defaults —
  // autonomy "off" etc.), and persist pref changes back to config.json with
  // the same key mapping the TUI settings picker writes.
  const PREF_KEYS = [
    'autonomy',
    'autonomyDelayMs',
    'autoProceedMaxIterations',
    'yolo',
    'maxIterations',
    'chime',
    'confirmExit',
    'streamFleet',
    'nextPrediction',
    'enhanceEnabled',
    'enhanceDelayMs',
    'enhanceLanguage',
    'featureMcp',
    'featurePlugins',
    'featureMemory',
    'featureSkills',
    'featureModelsRegistry',
    'indexOnStart',
    'contextAutoCompact',
    'contextStrategy',
    'logLevel',
    'auditLevel',
  ] as const;

  const prefSnapshot = (): Record<string, unknown> => {
    const snapshot: Record<string, unknown> = {};
    for (const k of PREF_KEYS) {
      if (k in opts.agent.ctx.meta) snapshot[k] = opts.agent.ctx.meta[k];
    }
    return snapshot;
  };

  if (opts.globalConfigPath) {
    try {
      const raw = await fs.readFile(opts.globalConfigPath, 'utf8');
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      const autonomyCfg = (cfg.autonomy as Record<string, unknown>) ?? {};
      const features = (cfg.features as Record<string, unknown>) ?? {};
      const meta = opts.agent.ctx.meta;
      const rawMode = autonomyCfg['defaultMode'];
      meta['autonomy'] = rawMode === 'suggest' || rawMode === 'auto' ? rawMode : 'off';
      meta['autonomyDelayMs'] = (autonomyCfg['autoProceedDelayMs'] as number) ?? 45_000;
      meta['autoProceedMaxIterations'] = (autonomyCfg['autoProceedMaxIterations'] as number) ?? 50;
      meta['yolo'] = (autonomyCfg['yolo'] as boolean) ?? (cfg.yolo as boolean) ?? false;
      meta['chime'] = (autonomyCfg['chime'] as boolean) ?? false;
      meta['confirmExit'] = autonomyCfg['confirmExit'] !== false;
      meta['streamFleet'] = autonomyCfg['streamFleet'] !== false;
      meta['enhanceEnabled'] = (autonomyCfg['enhance'] as boolean) ?? true;
      meta['enhanceDelayMs'] = (autonomyCfg['enhanceDelayMs'] as number) ?? 60_000;
      meta['enhanceLanguage'] = (autonomyCfg['enhanceLanguage'] as string) ?? 'original';
      meta['nextPrediction'] = (cfg.nextPrediction as boolean) ?? false;
      meta['featureMcp'] = features['mcp'] !== false;
      meta['featurePlugins'] = features['plugins'] !== false;
      meta['featureMemory'] = features['memory'] !== false;
      meta['featureSkills'] = features['skills'] !== false;
      meta['featureModelsRegistry'] = features['modelsRegistry'] !== false;
      meta['indexOnStart'] =
        (cfg.indexing as Record<string, unknown>)?.['onSessionStart'] !== false;
      meta['contextAutoCompact'] =
        (cfg.context as Record<string, unknown>)?.['autoCompact'] !== false;
      meta['contextStrategy'] = (cfg.context as Record<string, unknown>)?.['strategy'] ?? 'hybrid';
      meta['logLevel'] = (cfg.log as Record<string, unknown>)?.['level'] ?? 'info';
      meta['auditLevel'] = (cfg.session as Record<string, unknown>)?.['auditLevel'] ?? 'standard';
      meta['maxIterations'] = (cfg.tools as Record<string, unknown>)?.['maxIterations'] ?? 500;
    } catch {
      // best-effort — missing/corrupt config just leaves prefs unseeded
    }
  }

  let prefWriteLock: Promise<void> = Promise.resolve();
  const persistPrefsToConfig = async (payload: Record<string, unknown>): Promise<void> => {
    const configPath = opts.globalConfigPath;
    if (!configPath) return;
    const write = async (): Promise<void> => {
      let raw: string;
      try {
        raw = await fs.readFile(configPath, 'utf8');
      } catch {
        raw = '{}';
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return; // refuse to overwrite a corrupt-but-existing config
      }
      const vault = new DefaultSecretVault({
        keyFile: path.join(path.dirname(configPath), '.key'),
      });
      const decrypted = decryptConfigSecrets(parsed, vault) as Record<string, unknown>;

      const autonomyCfg = (decrypted.autonomy as Record<string, unknown>) ?? {};
      let autonomyTouched = false;
      const setAutonomy = (key: string, val: unknown): void => {
        autonomyCfg[key] = val;
        autonomyTouched = true;
      };
      if (
        typeof payload['autonomy'] === 'string' &&
        ['off', 'suggest', 'auto'].includes(payload['autonomy'])
      ) {
        setAutonomy('defaultMode', payload['autonomy']);
      }
      if (typeof payload['autonomyDelayMs'] === 'number')
        setAutonomy('autoProceedDelayMs', payload['autonomyDelayMs']);
      if (typeof payload['autoProceedMaxIterations'] === 'number')
        setAutonomy('autoProceedMaxIterations', payload['autoProceedMaxIterations']);
      if (typeof payload['yolo'] === 'boolean') setAutonomy('yolo', payload['yolo']);
      if (typeof payload['chime'] === 'boolean') setAutonomy('chime', payload['chime']);
      if (typeof payload['confirmExit'] === 'boolean')
        setAutonomy('confirmExit', payload['confirmExit']);
      if (typeof payload['streamFleet'] === 'boolean')
        setAutonomy('streamFleet', payload['streamFleet']);
      if (typeof payload['enhanceEnabled'] === 'boolean')
        setAutonomy('enhance', payload['enhanceEnabled']);
      if (typeof payload['enhanceDelayMs'] === 'number')
        setAutonomy('enhanceDelayMs', payload['enhanceDelayMs']);
      if (typeof payload['enhanceLanguage'] === 'string')
        setAutonomy('enhanceLanguage', payload['enhanceLanguage']);
      if (autonomyTouched) decrypted.autonomy = autonomyCfg;

      if (typeof payload['nextPrediction'] === 'boolean')
        decrypted.nextPrediction = payload['nextPrediction'];
      const FEATURE_MAP: Record<string, string> = {
        featureMcp: 'mcp',
        featurePlugins: 'plugins',
        featureMemory: 'memory',
        featureSkills: 'skills',
        featureModelsRegistry: 'modelsRegistry',
      };
      for (const [prefKey, cfgKey] of Object.entries(FEATURE_MAP)) {
        if (typeof payload[prefKey] === 'boolean') {
          const feats = (decrypted.features as Record<string, unknown>) ?? {};
          feats[cfgKey] = payload[prefKey];
          decrypted.features = feats;
        }
      }
      if (
        typeof payload['contextAutoCompact'] === 'boolean' ||
        typeof payload['contextStrategy'] === 'string'
      ) {
        const ctxCfg = (decrypted.context as Record<string, unknown>) ?? {};
        if (typeof payload['contextAutoCompact'] === 'boolean')
          ctxCfg.autoCompact = payload['contextAutoCompact'];
        if (typeof payload['contextStrategy'] === 'string')
          ctxCfg.strategy = payload['contextStrategy'];
        decrypted.context = ctxCfg;
      }
      if (typeof payload['logLevel'] === 'string') {
        const logCfg = (decrypted.log as Record<string, unknown>) ?? {};
        logCfg.level = payload['logLevel'];
        decrypted.log = logCfg;
      }
      if (typeof payload['auditLevel'] === 'string') {
        const sessionCfg = (decrypted.session as Record<string, unknown>) ?? {};
        sessionCfg.auditLevel = payload['auditLevel'];
        decrypted.session = sessionCfg;
      }
      if (typeof payload['indexOnStart'] === 'boolean') {
        const indexingCfg = (decrypted.indexing as Record<string, unknown>) ?? {};
        indexingCfg.onSessionStart = payload['indexOnStart'];
        decrypted.indexing = indexingCfg;
      }
      if (typeof payload['maxIterations'] === 'number') {
        const toolsCfg = (decrypted.tools as Record<string, unknown>) ?? {};
        toolsCfg.maxIterations = payload['maxIterations'];
        decrypted.tools = toolsCfg;
      }

      const encrypted = encryptConfigSecrets(decrypted, vault);
      await atomicWrite(configPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
    };
    const next = prefWriteLock.then(write);
    prefWriteLock = next.then(
      () => undefined,
      () => undefined,
    );
    try {
      await next;
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'warn',
          event: 'webui.prefs.persist_failed',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  };

  // Generate a random auth token to prevent unauthorized local connections.
  // The WebUI frontend reads this from the session.start payload and uses it
  // for subsequent reconnections. Loopback connections are exempt for
  // convenience (matches standalone WebUI server behavior).
  const authToken = crypto.randomBytes(16).toString('hex');
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
   * (reset, mode, replayMessages, etc.). The connection handler adds
   * wsToken on top.
   */
  async function buildSessionStartPayload(overrides?: Record<string, unknown>, needsSetup = false) {
    let maxContext = 0;
    let inputCost = 0;
    let outputCost = 0;
    let cacheReadCost = 0;
    try {
      if (opts.modelsRegistry) {
        const m = await opts.modelsRegistry.getModel(
          (opts.agent.ctx.provider as { id: string }).id,
          opts.agent.ctx.model,
        );
        const registryMax = (m as { capabilities?: { maxContext?: number } } | null)?.capabilities
          ?.maxContext;
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
      sessionId: opts.session.id,
      model: opts.agent.ctx.model,
      provider: (opts.agent.ctx.provider as { id: string }).id,
      mode: opts.modeId ?? 'default',
      projectName: opts.projectRoot ? path.basename(opts.projectRoot) : undefined,
      // Frontend reads `projectRoot` from session.start (ws-handlers setEnv) —
      // omitting it left the store's projectRoot empty after a project switch.
      projectRoot: opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '',
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
  const CLIENT_HEARTBEAT_MS = 15_000;

  const registerWebuiClient = async (): Promise<string | null> => {
    if (!opts.projectRoot) return null;
    try {
      const projectDir = resolveProjectDir(opts.projectRoot, wstackGlobalRoot());
      const mailbox = new GlobalMailbox(projectDir, opts.events);
      webuiClientId = `webui@${crypto.randomUUID().slice(0, 8)}`;
      const projectName = opts.projectRoot ? path.basename(opts.projectRoot) : 'unknown';
      await mailbox.registerClient({
        clientId: webuiClientId,
        sessionId: opts.projectRoot,
        name: `WebUI [${projectName}]`,
        source: 'webui',
        pid: process.pid,
      });

      webuiHeartbeatTimer = setInterval(() => {
        mailbox.clientHeartbeat({ clientId: webuiClientId! }).catch(() => {
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
  };

  // Register immediately (fire-and-forget so it doesn't block server startup)
  registerWebuiClient();

  const wss = new WebSocketServer({ port, host, maxPayload: 1 * 1024 * 1024 });

  console.log(`[WebUI] WebSocket server starting on ws://${host}:${port}`);

  // Serve the React frontend over HTTP so `wrongstack --webui` is a one-command
  // launch (open the printed URL) instead of only a WS bridge. The dist
  // discovery + HTTP server bring-up live in
  // `webui-server/static-serve.ts`; we just hand it the options and
  // wire the open-browser callback on top. If the webui package
  // isn't built, `startStaticServe` returns null and we degrade
  // gracefully to WS-only (the original behavior).
  const httpServer = startStaticServe({
    host,
    httpPort,
    wsPort,
    globalRoot: path.dirname(opts.globalConfigPath ?? ''),
  });
  if (httpServer) {
    announceWebuiReady({
      server: httpServer.server,
      host,
      httpPort,
      wsPort,
      open: !!opts.open,
    });
  } else {
    console.warn(
      `[WebUI] Frontend not served (run \`pnpm --filter @wrongstack/webui build\`). ` +
        `WS bridge still active on ws://${host}:${wsPort}.`,
    );
  }

  // Record this instance so it shows up in `webui --list` /
  // ~/.wrongstack/webui-instances.json alongside standalone instances.
  const registryBaseDir = opts.globalConfigPath ? path.dirname(opts.globalConfigPath) : undefined;
  if (opts.projectRoot) {
    registerWebuiInstance({
      pid: process.pid,
      host,
      httpPort,
      wsPort,
      projectRoot: opts.projectRoot,
      startedAt: new Date().toISOString(),
      registryBaseDir,
    });
  }
  // Auth token is sent to clients via the session.start payload — do NOT log it.

  // Subscribe to events once
  const eventUnsubscribers: Array<() => void> = [];

  // ── Fleet concurrency tracking ────────────────────────────────────────────
  // Tracks how many subagents are currently active (running) so the WebUI's
  // ConcurrencyGauge can show [████░░] 2/4 instead of always 0/4.
  // The leader is NOT counted — it's the host process, not a spawned worker.
  let fleetConcurrency = 0;
  // Default max matches the CLI default fleet size (4). A future
  // fleet.max_concurrency kernel event could override this dynamically.
  const FLEET_CONCURRENCY_MAX = 4;
  const emitConcurrency = () =>
    broadcast({
      type: 'fleet.concurrency_update',
      payload: { fleetConcurrency, fleetConcurrencyMax: FLEET_CONCURRENCY_MAX },
    });

  function setupEvents() {
    // Clear any existing subscriptions
    for (const unsub of eventUnsubscribers) unsub();
    eventUnsubscribers.length = 0;

    // ── Leader identity — the host is always the leader (agentId 'leader').
    // Emit once so the WebUI's fleet store sets leaderId and shows the crown.
    broadcast({
      type: 'subagent.event',
      payload: {
        kind: 'leader_updated',
        subagentId: 'leader',
        isLeader: true,
        name: 'Leader',
        status: 'running',
      },
    });

    // ── Fleet concurrency — emit the initial 0/N state so the gauge
    // renders immediately instead of waiting for the first spawn event.
    emitConcurrency();

    // iteration.started
    eventUnsubscribers.push(
      opts.events.on('iteration.started', (e) => {
        broadcast({
          type: 'iteration.started',
          payload: { index: e.index },
        });
      }),
    );

    // provider.text_delta
    eventUnsubscribers.push(
      opts.events.on('provider.text_delta', (e) => {
        broadcast({
          type: 'provider.text_delta',
          payload: { text: e.text, messageId: 'current' },
        });
      }),
    );

    // provider.thinking_delta — extended-thinking deltas. The WebUI renders a
    // transient "Thinking…" chip from these; clears the moment text_delta /
    // tool.started / provider.response / run.result lands so the chip never
    // pollutes the persisted transcript.
    eventUnsubscribers.push(
      opts.events.on('provider.thinking_delta', (e) => {
        broadcast({
          type: 'provider.thinking_delta',
          payload: { text: e.text },
        });
      }),
    );

    // tool.started
    eventUnsubscribers.push(
      opts.events.on('tool.started', (e) => {
        broadcast({
          type: 'tool.started',
          payload: {
            id: e.id,
            name: e.name,
            input: secretScrubber.scrubObject(e.input),
            messageId: `tool_${e.id}`,
          },
        });
      }),
    );

    // tool.progress
    eventUnsubscribers.push(
      opts.events.on('tool.progress', (e) => {
        broadcast({
          type: 'tool.progress',
          payload: {
            name: e.name,
            id: e.id,
            event: e.event,
          },
        });
      }),
    );

    // tool.executed
    eventUnsubscribers.push(
      opts.events.on('tool.executed', (e) => {
        broadcast({
          type: 'tool.executed',
          payload: {
            // Forward the tool_use id so the WebUI can correlate this with
            // the matching tool.started bubble for parallel tool calls.
            id: e.id,
            name: e.name,
            durationMs: e.durationMs,
            ok: e.ok,
            input: secretScrubber.scrubObject(e.input),
            output: secretScrubber.scrubObject(e.output),
          },
        });

        // Always broadcast current todos so the panel stays in sync.
        broadcast({
          type: 'todos.updated',
          payload: { todos: [...opts.agent.ctx.todos] },
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
                  payload: { tasks: file?.tasks ?? [] },
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
                  payload: {
                    plan: plan ?? {
                      version: 1,
                      sessionId: opts.session.id,
                      updatedAt: new Date().toISOString(),
                      items: [],
                    },
                  },
                });
              }
            } catch {
              /* best-effort */
            }
          })();
        }
      }),
    );

    // provider.response
    eventUnsubscribers.push(
      opts.events.on('provider.response', (e) => {
        broadcast({
          type: 'provider.response',
          payload: {
            usage: e.usage,
            stopReason: e.stopReason,
            messageId: 'current',
          },
        });
      }),
    );

    // error
    eventUnsubscribers.push(
      opts.events.on('error', (e) => {
        broadcast({
          type: 'error',
          payload: {
            phase: e.phase,
            message: e.err instanceof Error ? e.err.message : String(e.err),
          },
        });
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
          payload: {
            id,
            toolName: e.tool?.name ?? 'unknown',
            input: secretScrubber.scrubObject(e.input),
            suggestedPattern: e.suggestedPattern,
          },
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
      broadcast({ type: 'subagent.event', payload: { kind, ...payload } });
    eventUnsubscribers.push(
      opts.events.on('subagent.spawned', (e) => {
        fleetConcurrency += 1;
        emitConcurrency();
        forwardSubagent('spawned', {
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
          subagentId: e.subagentId,
          taskId: e.taskId,
          description: e.description,
        }),
      ),
      opts.events.on('subagent.tool_executed', (e) =>
        forwardSubagent('tool_executed', {
          subagentId: e.subagentId,
          toolName: e.name,
          durationMs: e.durationMs,
          ok: e.ok,
        }),
      ),
      opts.events.on('subagent.iteration_summary', (e) =>
        forwardSubagent('iteration_summary', {
          subagentId: e.subagentId,
          iteration: e.iteration,
          toolCalls: e.toolCalls,
          costUsd: e.costUsd,
          currentTool: e.currentTool,
        }),
      ),
      opts.events.on('subagent.budget_extended', (e) =>
        forwardSubagent('budget_extended', {
          subagentId: e.subagentId,
          totalExtensions: e.totalExtensions,
        }),
      ),
      opts.events.on('subagent.ctx_pct', (e) =>
        forwardSubagent('ctx_pct', {
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
          subagentId: e.subagentId,
          status: e.status,
          iterations: e.iterations,
          toolCalls: e.toolCalls,
          error: e.error ? { kind: e.error.kind, message: e.error.message } : undefined,
        });
      }),
    );

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
          payload: { event: eventName, ...(payload as Record<string, unknown>) },
        });
      }),
    );

    // ── Brain events — decisions + proactive interventions, live in the browser ──
    eventUnsubscribers.push(
      opts.events.onPattern('brain.*', (eventName, payload) => {
        broadcast({
          type: 'brain.event',
          payload: { event: eventName, ...(payload as Record<string, unknown>) },
        });
      }),
    );
  }

  return new Promise<void>((resolve) => {
    wss.on('listening', () => {
      console.log(`[WebUI] WebSocket server running on ws://${host}:${port}`);
      setupEvents();
      opts.onListening?.({ httpPort, wsPort, host });

      // ── Live session status poll ──────────────────────────────────
      // Periodically read the cross-process SessionRegistry and push
      // live agent/session status to all connected WebSocket clients.
      // This keeps the WebUI session panel in sync even when agents
      // run in background (project switches, multiple processes).
      const globalRoot = opts.globalConfigPath ? path.dirname(opts.globalConfigPath) : undefined;
      if (globalRoot) {
        const statusInterval = setInterval(async () => {
          try {
            // Lazy import to avoid bundling core into the webui runtime
            const { SessionRegistry } = await import('@wrongstack/core');
            const registry = new SessionRegistry(globalRoot);
            const sessions = await registry.list();
            const live = sessions
              .filter((s) => s.status !== 'stale')
              .map((s) => ({
                sessionId: s.sessionId,
                projectName: s.projectName,
                projectSlug: s.projectSlug,
                projectRoot: s.projectRoot,
                workingDir: s.workingDir,
                gitBranch: s.gitBranch,
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
                  lastActivityAt: a.lastActivityAt,
                })),
              }));
            broadcast({ type: 'sessions.status_update', payload: { sessions: live } });
          } catch {
            // Best-effort — never crash the WebSocket relay for status errors
          }
        }, 5_000);
        if (statusInterval.unref) statusInterval.unref();
        eventUnsubscribers.push(() => clearInterval(statusInterval));
      }
    });

    wss.on('connection', async (ws, req) => {
      // --- Auth token + Origin validation ---
      // Loopback connections (from the WebUI frontend on localhost) are
      // allowed without a token for convenience. Non-loopback connections
      // require the token passed as ?token=<authToken>.
      const isLoopback = (hostname: string) =>
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '[::1]';

      // Constant-time token compare (length mismatch short-circuits).
      const tokenMatches = (provided: string | null): boolean => {
        if (!provided) return false;
        const a = Buffer.from(provided);
        const b = Buffer.from(authToken);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      };

      try {
        const url = new URL(req.url ?? '/', `http://localhost:${port}`);
        const token = url.searchParams.get('token');
        const tokenOk = tokenMatches(token);

        // DNS-rebinding defense: the server is bound to loopback, so the Host
        // header of any legitimate client is a loopback name. A rebound
        // attacker page sends `Host: <attacker-domain>` even though the socket
        // peer is 127.0.0.1 — reject it.
        const hostHeader = (req.headers.host ?? '').trim();
        let hostOk = false;
        try {
          hostOk = !!hostHeader && isLoopback(new URL(`http://${hostHeader}`).hostname);
        } catch {
          hostOk = false;
        }
        if (!hostOk) {
          ws.close(4003, 'Forbidden: non-loopback Host header');
          return;
        }

        // Origin validation
        const origin = req.headers.origin;
        if (origin) {
          try {
            const { hostname } = new URL(origin);
            if (!isLoopback(hostname) && !tokenOk) {
              ws.close(4003, 'Forbidden: non-loopback origin requires auth token');
              return;
            }
          } catch {
            ws.close(4003, 'Forbidden: invalid origin');
            return;
          }
        } else {
          // Non-browser client (no origin header): require token for
          // defense-in-depth. Even though we bind to 127.0.0.1, a
          // compromised local process or DNS rebinding attack could
          // connect without an origin.
          if (!tokenOk) {
            ws.close(4003, 'Forbidden: auth token required for non-browser clients');
            return;
          }
        }
      } catch {
        ws.close(4001, 'Unauthorized: malformed request');
        return;
      }

      const client: ConnectedClient = { ws, sessionId: opts.session.id };
      clients.set(ws, client);

      // Register this client with the AutoPhase handler so it receives phase events
      autoPhaseHandler.addClient(ws);

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
              payload: { phase: 'rate_limit', message: 'Too many messages. Please wait.' },
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

  // Shared state for the extracted ws-handler groups (PR 5 of #30).
  // `send`/`broadcast` are hoisted function declarations, so capturing
  // them here is safe even though they're defined further down.
  const wsHandlerCtx: WsHandlerContext = {
    providerStore: createProviderConfigStore(opts.globalConfigPath),
    modelsRegistry: opts.modelsRegistry,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

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
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  async function handleMessage(
    ws: WebSocket,
    client: ConnectedClient,
    msg: WSClientMessage,
  ): Promise<void> {
    switch (msg.type) {
      case 'user_message':
        await handleUserMessage(
          ws,
          client,
          (msg as { payload: { content: string } }).payload.content,
        );
        break;

      case 'abort':
        // Scope the abort to the requesting socket. The legacy module-scope
        // `abortController` (project-switch path) is left alone — a
        // `case 'abort'` from one client should not interfere with another
        // client's in-flight run. The error message is sent only to the
        // requesting socket (was `broadcast({...})` previously), which is
        // correct: other clients have no idea what just happened.
        {
          const wsController = abortControllers.get(ws);
          wsController?.abort();
        }
        send(ws, {
          type: 'error',
          payload: { phase: 'abort', message: 'User aborted' },
        });
        break;

      case 'ping':
        send(ws, { type: 'pong', payload: {} });
        break;

      case 'tool.confirm_result': {
        const { id, decision } = (
          msg as { payload: { id: string; decision: 'yes' | 'no' | 'always' | 'deny' } }
        ).payload;
        const resolve = pendingConfirms.get(id);
        if (resolve) {
          pendingConfirms.delete(id);
          resolve(decision);
        }
        break;
      }

      case 'providers.list':
        await handleProvidersList(wsHandlerCtx, ws);
        break;

      case 'provider.models':
        await handleProviderModels(
          wsHandlerCtx,
          ws,
          (msg as { payload: { providerId: string } }).payload.providerId,
        );
        break;

      case 'providers.saved':
        await handleProvidersSaved(wsHandlerCtx, ws);
        break;

      case 'key.add':
      case 'key.update': {
        const m = msg as { payload: { providerId: string; label: string; apiKey: string } };
        await handleKeyUpsert(wsHandlerCtx, ws, m.payload.providerId, m.payload.label, m.payload.apiKey);
        break;
      }

      case 'key.delete': {
        const m = msg as { payload: { providerId: string; label: string } };
        await handleKeyDelete(wsHandlerCtx, ws, m.payload.providerId, m.payload.label);
        break;
      }

      case 'key.set_active': {
        const m = msg as { payload: { providerId: string; label: string } };
        await handleKeySetActive(wsHandlerCtx, ws, m.payload.providerId, m.payload.label);
        break;
      }

      case 'provider.add': {
        const m = msg as {
          payload: {
            id: string;
            family: string;
            baseUrl?: string | undefined;
            apiKey?: string | undefined;
          };
        };
        await handleProviderAdd(wsHandlerCtx, ws, m.payload);
        break;
      }

      case 'provider.remove': {
        const m = msg as { payload: { providerId: string } };
        await handleProviderRemove(wsHandlerCtx, ws, m.payload.providerId);
        break;
      }

      case 'todos.get': {
        // On-demand snapshot — sends the live todo list from agent ctx.
        // Mirrors the standalone server's handler.
        send(ws, {
          type: 'todos.updated',
          payload: { todos: [...opts.agent.ctx.todos] },
        });
        break;
      }

      case 'goal.get': {
        // Read goal.json from disk and broadcast to all connected clients.
        // The frontend polls this periodically; we serve the latest snapshot.
        const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
        try {
          const goalPath = path.join(projectRoot, '.wrongstack', 'goal.json');
          const raw = await fs.readFile(goalPath, 'utf8');
          const goal = JSON.parse(raw);
          broadcast({ type: 'goal.updated', payload: goal });
        } catch {
          broadcast({ type: 'goal.updated', payload: null });
        }
        break;
      }

      case 'sessions.list': {
        // Prefer the wired SessionStore (the real ~/.wrongstack/projects/<hash>/
        // sessions location). The transient store at <projectRoot>/.wrongstack/
        // sessions is a legacy fallback only — real sessions never live there.
        const limit = (msg as { payload?: { limit?: number | undefined } }).payload?.limit ?? 50;
        try {
          const store =
            opts.sessionStore ??
            new DefaultSessionStore({
              dir: path.join(
                opts.projectRoot ?? opts.agent.ctx.projectRoot,
                '.wrongstack',
                'sessions',
              ),
            });
          const list = await store.list(limit);
          const currentId = opts.agent.ctx.session?.id ?? opts.session.id;
          send(ws, {
            type: 'sessions.list',
            payload: {
              sessions: list.map((s) => ({
                id: s.id,
                title: s.title,
                startedAt: s.startedAt,
                model: s.model,
                provider: s.provider,
                tokenTotal: s.tokenTotal,
                isCurrent: s.id === currentId,
              })),
            },
          });
        } catch (err) {
          send(ws, {
            type: 'sessions.list',
            payload: { sessions: [], error: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case 'session.new': {
        // Full new session when the SessionStore is wired (the normal case):
        // finalize the current writer (session_end + close → summary sidecar)
        // and swap in a fresh on-disk session, exactly like the standalone
        // server. Previously this only wiped in-memory state — the "new"
        // conversation kept appending to the OLD session's JSONL.
        const ctx = opts.agent.ctx;
        const oldId = ctx.session?.id ?? opts.session.id;
        if (opts.sessionStore) {
          try {
            const oldWriter = ctx.session;
            const oldUsage = ctx.tokenCounter.total();
            if (oldWriter) {
              void (async () => {
                await oldWriter
                  .append({ type: 'session_end', ts: new Date().toISOString(), usage: oldUsage })
                  .catch(() => undefined);
                await oldWriter.close().catch(() => undefined);
              })();
            }
            const fresh = await opts.sessionStore.create({
              id: '',
              title: '',
              model: ctx.model,
              provider: (ctx.provider as { id?: string }).id ?? '',
            });
            ctx.session = fresh;
            opts.onSessionSwapped?.(fresh.id);
            ctx.tokenCounter.reset();
          } catch (err) {
            // Store failure degrades to the in-memory reset below.
            console.warn(
              JSON.stringify({
                level: 'warn',
                event: 'webui.session_new_store_failed',
                message: err instanceof Error ? err.message : String(err),
                timestamp: new Date().toISOString(),
              }),
            );
          }
        }
        ctx.state.replaceMessages([]);
        ctx.state.replaceTodos([]);
        ctx.readFiles.clear();
        ctx.fileMtimes.clear();
        const sessNewP = await buildSessionStartPayload({ reset: true, clearedSessionId: oldId });
        broadcast({ type: 'session.start', payload: sessNewP });
        break;
      }

      case 'todos.clear': {
        // Manual override — clear the todo list without losing context.
        opts.agent.ctx.state.replaceTodos([]);
        sendResult(ws, true, 'Todos cleared');
        broadcast({ type: 'todos.updated', payload: { todos: [] } });
        break;
      }

      case 'todos.remove': {
        const payload = msg.payload as
          | { id?: string | undefined; index?: number | undefined }
          | undefined;
        if (!payload) {
          sendResult(ws, false, 'Missing id or index');
          break;
        }
        const { id, index } = payload;
        const todos = opts.agent.ctx.todos;
        let targetIdx = -1;
        if (typeof id === 'string') {
          targetIdx = todos.findIndex((t) => t.id === id);
        } else if (typeof index === 'number' && index > 0) {
          targetIdx = index - 1;
        }
        if (targetIdx < 0 || !todos[targetIdx]) {
          sendResult(ws, false, 'Todo not found');
          break;
        }
        const removed = expectDefined(todos[targetIdx]);
        const next = [...todos.slice(0, targetIdx), ...todos.slice(targetIdx + 1)];
        opts.agent.ctx.state.replaceTodos(next);
        sendResult(ws, true, `Removed: ${removed.content}`);
        broadcast({ type: 'todos.updated', payload: { todos: next } });
        break;
      }

      case 'todo.update': {
        // Update a todo's status and/or activeForm in agent context.
        const payload = msg.payload as {
          id: string;
          status?: TodoItem['status'] | undefined;
          activeForm?: string | undefined;
        };
        const todos = opts.agent.ctx.todos;
        const idx = todos.findIndex((t) => t.id === payload.id);
        if (idx === -1) {
          sendResult(ws, false, 'Todo not found');
          break;
        }
        const next = [...todos];
        const existing = expectDefined(next[idx]);
        next[idx] = {
          ...existing,
          status: payload.status ?? existing.status,
          activeForm: payload.activeForm !== undefined ? payload.activeForm : existing.activeForm,
        };
        opts.agent.ctx.state.replaceTodos(next);
        sendResult(ws, true, `Todo "${existing.content}" updated`);
        broadcast({ type: 'todos.updated', payload: { todos: next } });
        break;
      }

      case 'context.clear': {
        // In-memory wipe — same as session.new but reuses the current session.
        const ctx = opts.agent.ctx;
        ctx.state.replaceMessages([]);
        ctx.state.replaceTodos([]);
        ctx.readFiles.clear();
        ctx.fileMtimes.clear();
        sendResult(ws, true, 'Context cleared');
        const ctxClearP = await buildSessionStartPayload({ reset: true });
        broadcast({ type: 'session.start', payload: ctxClearP });
        break;
      }

      case 'process.list': {
        try {
          const { getProcessRegistry } = await import('@wrongstack/tools');
          const procs = getProcessRegistry().list();
          send(ws, {
            type: 'process.list',
            payload: {
              processes: procs.map((p) => ({
                pid: p.pid,
                command: p.command,
                tool: p.name,
                startedAt: p.startedAt,
                status: p.killed ? ('killed' as const) : ('running' as const),
                protected: p.protected,
              })),
            },
          });
        } catch {
          send(ws, { type: 'process.list', payload: { processes: [] } });
        }
        break;
      }

      case 'process.kill': {
        const { pid } = (msg as { payload: { pid: number } }).payload;
        try {
          const { getProcessRegistry } = await import('@wrongstack/tools');
          const proc = getProcessRegistry().get(pid);
          if (proc?.protected) {
            sendResult(ws, false, `Cannot kill protected process (PID ${pid})`);
            break;
          }
          getProcessRegistry().kill(pid);
          sendResult(ws, true, `Killed PID ${pid}`);
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'process.killAll': {
        try {
          const { getProcessRegistry } = await import('@wrongstack/tools');
          getProcessRegistry().killAll();
          sendResult(ws, true, 'All processes killed');
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'diag.get': {
        // Snapshot of key metrics — mirrors the standalone server's handler
        // and the CLI /diag output. Uses the agent context for live state.
        const ctx = opts.agent.ctx;
        const tools = opts.agent.tools.list();
        send(ws, {
          type: 'diag.get',
          payload: {
            provider: (ctx.provider as { id: string }).id,
            model: ctx.model,
            cwd: opts.projectRoot ?? ctx.projectRoot,
            sessionId: opts.session.id,
            tools: {
              count: tools.length,
              names: tools.map((t) => t.name),
            },
            features: {},
            mode: 'default',
            usage: ctx.tokenCounter.total(),
            messages: ctx.messages.length,
            todos: ctx.todos.length,
          },
        });
        break;
      }

      case 'stats.get': {
        // Detailed session usage stats, mirroring the CLI /stats.
        const ctx = opts.agent.ctx;
        const usage = ctx.tokenCounter.total();
        const cacheStats = ctx.tokenCounter.cacheStats();
        let cost: number | null = null;
        try {
          if (opts.modelsRegistry) {
            const model = await opts.modelsRegistry.getModel(
              (ctx.provider as { id: string }).id,
              ctx.model,
            );
            const rates = getCostRates(model);
            cost = computeUsageCost(
              { input: usage.input, output: usage.output, cacheRead: cacheStats.readTokens },
              rates,
            );
          }
        } catch {
          /* cost stays null */
        }
        send(ws, {
          type: 'stats.get',
          payload: {
            sessionId: opts.session.id,
            provider: (ctx.provider as { id: string }).id,
            model: ctx.model,
            usage,
            cache: cacheStats,
            cost,
            messages: ctx.messages.length,
            readFiles: ctx.readFiles.size,
            tools: opts.agent.tools.list().length,
            elapsedMs: Date.now() - sessionStartedAt,
          },
        });
        break;
      }

      case 'autonomy.switch': {
        const { mode } = (msg as { payload: { mode: string } }).payload;
        opts.agent.ctx.meta['autonomy'] = mode;
        // Flip the CLI's REAL autonomy state (same setter the TUI uses) —
        // meta alone is advisory and the running loop never reads it.
        opts.onAutonomySwitch?.(mode);
        sendResult(ws, true, `Autonomy mode set to "${mode}"`);
        broadcast({ type: 'prefs.updated', payload: { autonomy: mode } });
        void persistPrefsToConfig({ autonomy: mode });
        break;
      }

      case 'tools.list': {
        const list = opts.agent.tools.list().map((t) => {
          const schema =
            (t as { inputSchema?: { properties?: Record<string, unknown> } }).inputSchema ?? {};
          const params = schema.properties ? Object.keys(schema.properties) : [];
          return {
            name: t.name,
            description: (t as { description?: string | undefined }).description ?? '',
            params,
          };
        });
        send(ws, { type: 'tools.list', payload: { tools: list } });
        break;
      }

      case 'session.checkpoints': {
        const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
        try {
          const { DefaultSessionRewinder } = await import('@wrongstack/core');
          const rewinder = new DefaultSessionRewinder(
            opts.sessionsDir ?? path.join(projectRoot, '.wrongstack', 'sessions'),
            projectRoot,
          );
          // Use the LIVE writer's id — after an in-app resume the active
          // session is agent.ctx.session, not the startup one.
          const liveId = opts.agent.ctx.session?.id ?? opts.session.id;
          const checkpoints = await rewinder.listCheckpoints(liveId);
          send(ws, {
            type: 'session.checkpoints',
            payload: { checkpoints },
          });
        } catch {
          send(ws, {
            type: 'session.checkpoints',
            payload: { checkpoints: [] },
          });
        }
        break;
      }

      case 'session.rewind': {
        const { checkpointIndex } = (msg as { payload: { checkpointIndex: number } }).payload;
        const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
        try {
          const { DefaultSessionRewinder } = await import('@wrongstack/core');
          const rewinder = new DefaultSessionRewinder(
            opts.sessionsDir ?? path.join(projectRoot, '.wrongstack', 'sessions'),
            projectRoot,
          );
          // Rewind the LIVE session — both the file reverts (rewinder) and
          // the JSONL truncation (writer) must target the same session.
          const liveSession = opts.agent.ctx.session ?? opts.session;
          await rewinder.rewindToCheckpoint(liveSession.id, checkpointIndex);
          await liveSession.truncateToCheckpoint(checkpointIndex);
          sendResult(ws, true, `Rewound to checkpoint ${checkpointIndex}`);
          const rewindP = await buildSessionStartPayload({ reset: true });
          broadcast({ type: 'session.start', payload: rewindP });
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      // ── File operations — delegated to shared handlers (file-handlers.ts) ──
      // These handlers are also used by the standalone WebUI server. When
      // adding or modifying file-operation WebSocket messages, update
      // file-handlers.ts — NOT these case blocks individually.
      case 'files.list': {
        const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
        return handleFilesList(ws, msg, projectRoot);
      }
      case 'files.tree': {
        const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
        return handleFilesTree(ws, msg, projectRoot);
      }
      case 'files.read': {
        const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
        return handleFilesRead(ws, msg, projectRoot);
      }
      case 'files.write': {
        const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
        return handleFilesWrite(ws, msg, projectRoot);
      }

      case 'session.delete': {
        const { id } = (msg as { payload: { id: string } }).payload;
        // Guard against the CURRENT writer — after an in-app resume the
        // active session is agent.ctx.session, not the startup one.
        if (id === (opts.agent.ctx.session?.id ?? opts.session.id)) {
          sendResult(ws, false, 'Cannot delete the active session');
          break;
        }
        try {
          // Prefer the wired SessionStore (real sessions location); the
          // transient <projectRoot>/.wrongstack/sessions store is legacy-only.
          const store =
            opts.sessionStore ??
            new DefaultSessionStore({
              dir: path.join(
                opts.projectRoot ?? opts.agent.ctx.projectRoot,
                '.wrongstack',
                'sessions',
              ),
            });
          await store.delete(id);
          sendResult(ws, true, `Session ${id} deleted`);
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'session.save':
        // SessionWriter auto-flushes — confirm for UI habit parity.
        sendResult(ws, true, `Session ${opts.session.id} is auto-saved`);
        break;

      case 'plan.get': {
        // On-demand plan snapshot from context.meta.
        const planPath = (opts.agent.ctx.meta as Record<string, unknown>)['plan.path'];
        if (typeof planPath === 'string' && planPath) {
          try {
            const { loadPlan } = await import('@wrongstack/core');
            const plan = await loadPlan(planPath);
            send(ws, {
              type: 'plan.updated',
              payload: {
                plan: plan ?? {
                  version: 1,
                  sessionId: opts.session.id,
                  updatedAt: new Date().toISOString(),
                  items: [],
                },
              },
            });
          } catch {
            send(ws, {
              type: 'plan.updated',
              payload: {
                plan: {
                  version: 1,
                  sessionId: opts.session.id,
                  updatedAt: new Date().toISOString(),
                  items: [],
                },
              },
            });
          }
        } else {
          send(ws, {
            type: 'plan.updated',
            payload: { plan: null, error: 'Plan storage is not configured for this session.' },
          });
        }
        break;
      }

      case 'plan.template_use': {
        const { template } = (msg as { payload: { template: string } }).payload;
        const planPath = (opts.agent.ctx.meta as Record<string, unknown>)['plan.path'];
        if (typeof planPath !== 'string' || !planPath) {
          sendResult(ws, false, 'Plan storage is not configured for this session.');
          break;
        }
        try {
          const { getPlanTemplate, loadPlan, savePlan, emptyPlan, addPlanItem } = await import(
            '@wrongstack/core'
          );
          const tpl = getPlanTemplate(template);
          if (!tpl) {
            sendResult(ws, false, `Unknown template "${template}".`);
            break;
          }
          let plan = (await loadPlan(planPath)) ?? emptyPlan(opts.session.id);
          for (const item of tpl.items) {
            ({ plan } = addPlanItem(plan, item.title, item.details));
          }
          await savePlan(planPath, plan);
          sendResult(ws, true, `Applied template "${tpl.name}" — ${tpl.items.length} items added.`);
          broadcast({
            type: 'plan.updated',
            payload: { plan },
          });
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'plan.item.update': {
        // Update a single plan item's status and broadcast.
        const planPath = (opts.agent.ctx.meta as Record<string, unknown>)['plan.path'];
        if (typeof planPath !== 'string' || !planPath) {
          sendResult(ws, false, 'Plan storage is not configured for this session.');
          break;
        }
        const payload = msg.payload as {
          target: string;
          status: 'open' | 'in_progress' | 'done';
        };
        try {
          const sessionId = opts.session.id;
          let changed = false;
          const plan = await mutatePlan(planPath, sessionId, async (p) => {
            const before = p.updatedAt;
            const next = setPlanItemStatus(p, payload.target, payload.status);
            changed = next.updatedAt !== before;
            return next;
          });
          if (!changed) {
            sendResult(ws, false, `No plan item matched "${payload.target}".`);
            break;
          }
          sendResult(ws, true, `Plan item status updated to "${payload.status}".`);
          broadcast({ type: 'plan.updated', payload: { plan } });
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      // ── Memory operations — delegated to shared handlers (memory-handlers.ts) ──
      case 'memory.list': {
        if (!opts.memoryStore) {
          send(ws, {
            type: 'memory.list',
            payload: { text: '', error: 'Memory store not available' },
          });
          break;
        }
        return handleMemoryList(ws, opts.memoryStore);
      }
      case 'memory.remember': {
        if (!opts.memoryStore) {
          sendResult(ws, false, 'Memory store not available');
          break;
        }
        return handleMemoryRemember(ws, msg, opts.memoryStore);
      }
      case 'memory.forget': {
        if (!opts.memoryStore) {
          sendResult(ws, false, 'Memory store not available');
          break;
        }
        return handleMemoryForget(ws, msg, opts.memoryStore);
      }

      case 'skills.list': {
        if (!opts.skillLoader) {
          send(ws, { type: 'skills.list', payload: { skills: [], enabled: false } });
          break;
        }
        try {
          const manifests = await opts.skillLoader.list();
          const entries = await opts.skillLoader.listEntries();
          const byName = new Map(entries.map((e) => [e.name, e]));
          send(ws, {
            type: 'skills.list',
            payload: {
              enabled: true,
              skills: manifests.map((m) => ({
                name: m.name,
                description: m.description,
                version: m.version ?? '',
                source: m.source,
                path: m.path,
                trigger: byName.get(m.name)?.trigger ?? '',
                scope: byName.get(m.name)?.scope ?? [],
              })),
            },
          });
        } catch (err) {
          send(ws, {
            type: 'skills.list',
            payload: {
              skills: [],
              enabled: true,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
        break;
      }

      case 'modes.list': {
        if (!opts.modeStore) {
          send(ws, {
            type: 'modes.list',
            payload: { modes: [], activeId: 'default', error: 'Mode store not available' },
          });
          break;
        }
        try {
          const modes = await opts.modeStore.listModes();
          const active = await opts.modeStore.getActiveMode();
          send(ws, {
            type: 'modes.list',
            payload: {
              modes: modes.map((m) => ({
                id: m.id,
                name: m.name,
                description: m.description,
                isActive: m.id === (active?.id ?? 'default'),
              })),
              activeId: active?.id ?? 'default',
            },
          });
        } catch (err) {
          send(ws, {
            type: 'modes.list',
            payload: {
              modes: [],
              activeId: 'default',
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
        break;
      }

      case 'mode.switch': {
        if (!opts.modeStore) {
          sendResult(ws, false, 'Mode store not available');
          break;
        }
        const { id } = (msg as { payload: { id: string } }).payload;
        try {
          if (id === 'default') {
            await opts.modeStore.setActiveMode(null);
          } else {
            const found = await opts.modeStore.getMode(id);
            if (!found) throw new Error(`Unknown mode "${id}"`);
            await opts.modeStore.setActiveMode(id);
          }
          // Store the mode in context.meta so the agent sees it on the next turn.
          opts.agent.ctx.meta['mode'] = id;
          sendResult(ws, true, `Switched to mode "${id}"`);
          const modeSwP = await buildSessionStartPayload({ mode: id });
          broadcast({ type: 'session.start', payload: modeSwP });
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'model.switch': {
        const { provider: newProvider, model: newModel } = (
          msg as { payload: { provider: string; model: string } }
        ).payload;
        try {
          // Update context
          const ctx = opts.agent.ctx;
          ctx.model = newModel;

          // Create a new provider instance from the saved config
          const { makeProviderFromConfig } = await import('@wrongstack/providers');
          const { loadSavedProviders } = await import('./webui-server/provider-config.js');
          const saved = await loadSavedProviders(opts.globalConfigPath);
          const providerCfg = saved[newProvider] ?? { type: newProvider };
          const newProv = makeProviderFromConfig(newProvider, providerCfg);
          ctx.provider = newProv;

          send(ws, {
            type: 'key.operation_result',
            payload: { success: true, message: `Switched to ${newProvider} / ${newModel}` },
          });
          const modelSwP = await buildSessionStartPayload();
          broadcast({ type: 'session.start', payload: modelSwP });
        } catch (err) {
          send(ws, {
            type: 'key.operation_result',
            payload: {
              success: false,
              message: `Switch failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          });
        }
        break;
      }

      case 'session.resume': {
        if (!opts.sessionStore) {
          sendResult(ws, false, 'Session store not available');
          break;
        }
        const { id } = (msg as { payload: { id: string } }).payload;
        try {
          // Compare against the CURRENT writer — after a prior in-app resume
          // the active session is agent.ctx.session, not the startup one.
          const ctx = opts.agent.ctx;
          if (id === (ctx.session?.id ?? opts.session.id)) {
            sendResult(ws, false, 'Session is already active');
            break;
          }
          const resumed = await opts.sessionStore.resume(id);
          // Finalize the writer we are leaving (session_end + flush + summary
          // sidecar), then swap the context to the resumed writer so all new
          // events land in the resumed session's JSONL. Without the swap,
          // the conversation kept recording into the old session's log and
          // the resumed writer leaked an open file handle.
          const oldWriter = ctx.session;
          if (oldWriter && oldWriter !== resumed.writer) {
            const oldUsage = ctx.tokenCounter.total();
            void (async () => {
              await oldWriter
                .append({
                  type: 'session_end',
                  ts: new Date().toISOString(),
                  usage: oldUsage,
                })
                .catch(() => undefined);
              await oldWriter.close().catch(() => undefined);
            })();
          }
          ctx.session = resumed.writer;
          // Let the host re-point crash-recovery state (active.json) at the
          // session that is now actually being written.
          opts.onSessionSwapped?.(resumed.writer.id);
          // Hydrate the context with the old session's messages.
          ctx.state.replaceMessages(resumed.data.messages);
          ctx.state.replaceTodos([]);
          ctx.readFiles.clear();
          ctx.fileMtimes.clear();
          ctx.tokenCounter.reset();
          // Replay usage so the topbar shows accurate totals.
          ctx.tokenCounter.account(resumed.data.usage, ctx.model);
          const resumeP = await buildSessionStartPayload({
            reset: true,
            replayMessages: resumed.data.messages,
            replayUsage: resumed.data.usage,
          });
          broadcast({ type: 'session.start', payload: resumeP });
          sendResult(ws, true, `Resumed session ${id}`);
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'context.debug': {
        // Per-section token estimate so users can see what's eating the context window.
        const ctx = opts.agent.ctx;
        const breakdown = estimateContextBreakdown({
          systemPrompt: ctx.systemPrompt as ReadonlyArray<PromptBlock>,
          tools: opts.agent.tools.list() as ReadonlyArray<ToolLike>,
          messages: ctx.messages as ReadonlyArray<MessageLike>,
        });
        send(ws, {
          type: 'context.debug',
          payload: {
            ...breakdown,
            mode: (ctx.meta['contextWindowMode'] as string) ?? DEFAULT_CONTEXT_WINDOW_MODE_ID,
            policy: ctx.meta['contextWindowPolicy'] ?? null,
          },
        });
        break;
      }

      case 'context.compact': {
        const aggressive = !!(msg as { payload?: { aggressive?: boolean | undefined } }).payload
          ?.aggressive;
        try {
          const compactor = opts.agent.container.resolve(TOKENS.Compactor);
          if (!compactor) {
            sendResult(ws, false, 'Compactor not available');
            break;
          }
          const before = opts.agent.ctx.tokenCounter.total();
          const report = await compactor.compact(opts.agent.ctx, { aggressive });
          const after = opts.agent.ctx.tokenCounter.total();
          send(ws, {
            type: 'context.compacted',
            payload: {
              before: before.input + before.output,
              after: after.input + after.output,
              saved: Math.max(0, before.input + before.output - after.input - after.output),
              reductions: report.reductions ?? [],
              repaired: report.repaired ?? false,
            },
          });
          sendResult(
            ws,
            true,
            `Compacted: ${before.input + before.output} → ${after.input + after.output} tokens`,
          );
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'context.repair': {
        const ctx = opts.agent.ctx;
        const beforeMessages = ctx.messages.length;
        const repaired = repairToolUseAdjacency(ctx.messages);
        if (repaired.report.changed) {
          ctx.state.replaceMessages(repaired.messages);
        }
        const payload = {
          removedToolUses: repaired.report.removedToolUses,
          removedToolResults: repaired.report.removedToolResults,
          removedMessages: repaired.report.removedMessages,
          beforeMessages,
          afterMessages: ctx.messages.length,
        };
        broadcast({ type: 'context.repaired', payload });
        const removed =
          payload.removedToolUses.length +
          payload.removedToolResults.length +
          payload.removedMessages;
        sendResult(
          ws,
          true,
          removed > 0
            ? `Context repaired: removed ${removed} orphan protocol item(s)`
            : 'Context repair found no orphan protocol blocks',
        );
        break;
      }

      case 'context.modes.list': {
        // Built-ins + file-backed custom modes (store.list() merges both),
        // matching the standalone server.
        const active = String(
          opts.agent.ctx.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID,
        );
        const modeStore = await getCustomModeStore();
        send(ws, {
          type: 'context.modes.list',
          payload: {
            activeId: active,
            modes: modeStore.list().map((m) => ({
              id: m.id,
              name: m.name,
              description: m.description,
              isActive: m.id === active,
              thresholds: m.thresholds,
              preserveK: m.preserveK,
              eliseThreshold: m.eliseThreshold,
              custom: m.custom === true,
            })),
          },
        });
        break;
      }

      case 'context.mode.switch': {
        const { id } = (msg as { payload: { id: string } }).payload;
        // Built-in first, then custom (parity with the standalone server —
        // custom modes were previously unswitchable here).
        let policy = resolveContextWindowPolicy({}, id);
        if (policy.id !== id) {
          const modeStore = await getCustomModeStore();
          const custom = modeStore.list().find((m) => m.custom === true && m.id === id);
          if (!custom) {
            sendResult(ws, false, `Unknown context mode "${id}"`);
            break;
          }
          policy = custom as unknown as typeof policy;
        }
        opts.agent.ctx.meta['contextWindowMode'] = policy.id;
        opts.agent.ctx.meta['contextWindowPolicy'] = policy;
        sendResult(ws, true, `Context mode switched to ${policy.id}`);
        broadcast({
          type: 'context.mode.changed',
          payload: { id: policy.id, name: policy.name, policy },
        });
        break;
      }

      case 'context.mode.create': {
        const payload = (
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
        ).payload;
        const modeStore = await getCustomModeStore();
        const result = modeStore.create({
          id: payload.id,
          name: payload.name,
          description: payload.description,
          thresholds: payload.thresholds,
          preserveK: payload.preserveK,
          eliseThreshold: payload.eliseThreshold,
          custom: true,
          aggressiveOn: 'soft',
          targetLoad: 0.65,
        });
        if (result.ok)
          await modeStore.save().catch(() => undefined); /* best-effort: user preferences */
        sendResult(ws, result.ok, result.error ?? `Mode "${payload.id}" created`);
        break;
      }

      case 'context.mode.update': {
        const payload = (
          msg as {
            payload: {
              id: string;
              name?: string | undefined;
              description?: string | undefined;
              thresholds?:
                | {
                    warn?: number | undefined;
                    soft?: number | undefined;
                    hard?: number | undefined;
                  }
                | undefined;
              preserveK?: number | undefined;
              eliseThreshold?: number | undefined;
            };
          }
        ).payload;
        const modeStore = await getCustomModeStore();
        // Build the patch without explicit-undefined keys
        // (exactOptionalPropertyTypes).
        const result = modeStore.update(payload.id, {
          ...(payload.name !== undefined ? { name: payload.name } : {}),
          ...(payload.description !== undefined ? { description: payload.description } : {}),
          ...(payload.thresholds
            ? {
                thresholds: {
                  warn: payload.thresholds.warn ?? 0.6,
                  soft: payload.thresholds.soft ?? 0.75,
                  hard: payload.thresholds.hard ?? 0.9,
                },
              }
            : {}),
          ...(payload.preserveK !== undefined ? { preserveK: payload.preserveK } : {}),
          ...(payload.eliseThreshold !== undefined
            ? { eliseThreshold: payload.eliseThreshold }
            : {}),
        });
        if (result.ok)
          await modeStore.save().catch(() => undefined); /* best-effort: user preferences */
        sendResult(ws, result.ok, result.error ?? `Mode "${payload.id}" updated`);
        break;
      }

      case 'context.mode.delete': {
        const { id } = (msg as { payload: { id: string } }).payload;
        const ctx = opts.agent.ctx;
        // If the active mode is being deleted, fall back to the default.
        if (String(ctx.meta['contextWindowMode'] ?? '') === id) {
          ctx.meta['contextWindowMode'] = DEFAULT_CONTEXT_WINDOW_MODE_ID;
          ctx.meta['contextWindowPolicy'] = resolveContextWindowPolicy(
            {},
            DEFAULT_CONTEXT_WINDOW_MODE_ID,
          );
        }
        const modeStore = await getCustomModeStore();
        const result = modeStore.remove(id);
        if (result.ok)
          await modeStore.save().catch(() => undefined); /* best-effort: user preferences */
        sendResult(ws, result.ok, result.error ?? `Mode "${id}" deleted`);
        break;
      }

      // ── Brain — status, autonomy ceiling, direct decision support ───
      // Shares the HOST's brain (TOKENS.BrainArbiter) and the same settings
      // object the /brain slash command mutates, so the ceiling shown in the
      // terminal and the WebUI never diverge. These used to be unknown
      // message types on the embedded server.
      case 'brain.status': {
        handleBrainStatus(brainCtx, ws);
        break;
      }

      case 'brain.risk': {
        const level = (msg as { payload?: { level?: string } }).payload?.level ?? '';
        handleBrainRisk(brainCtx, ws, level);
        break;
      }

      case 'brain.ask': {
        const question = (msg as { payload?: { question?: string } }).payload?.question;
        await handleBrainAsk(brainCtx, ws, question);
        break;
      }

      // ── Preferences ──────────────────────────────────────────

      case 'prefs.get': {
        // Return the current pref snapshot from context.meta so the
        // frontend can seed its local-prefs store from the server's truth.
        send(ws, { type: 'prefs.updated', payload: prefSnapshot() });
        break;
      }

      case 'prefs.update': {
        // Batch preference update. Merges arbitrary key/value pairs into
        // context.meta so the runtime can read them immediately, broadcasts
        // the full pref snapshot to every connected client so all browser
        // tabs stay in sync, and persists the durable keys to config.json
        // (same key mapping the TUI settings picker writes).
        const payload = (msg as { payload: Record<string, unknown> }).payload;
        for (const [key, val] of Object.entries(payload)) {
          opts.agent.ctx.meta[key] = val;
        }
        void persistPrefsToConfig(payload);
        broadcast({ type: 'prefs.updated', payload: prefSnapshot() });
        break;
      }

      // ── Tasks ───────────────────────────────────────────────

      case 'tasks.get': {
        // On-demand task snapshot — loads from <sessionId>.tasks.json
        const taskPath = (opts.agent.ctx.meta as Record<string, unknown>)['task.path'];
        if (typeof taskPath === 'string' && taskPath) {
          try {
            const { loadTasks } = await import('@wrongstack/core');
            const file = await loadTasks(taskPath);
            send(ws, {
              type: 'tasks.updated',
              payload: { tasks: file?.tasks ?? [] },
            });
          } catch {
            send(ws, { type: 'tasks.updated', payload: { tasks: [] } });
          }
        } else {
          send(ws, {
            type: 'tasks.updated',
            payload: { tasks: [], error: 'Task storage not configured.' },
          });
        }
        break;
      }

      case 'task.update': {
        // Update a task's status in the task file and broadcast.
        const taskPath = (opts.agent.ctx.meta as Record<string, unknown>)['task.path'];
        if (typeof taskPath !== 'string' || !taskPath) {
          sendResult(ws, false, 'Task storage not configured.');
          break;
        }
        const payload = msg.payload as {
          id: string;
          status: 'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed';
        };
        try {
          const sessionId = opts.session.id;
          const file = await mutateTasks(taskPath, sessionId, async (f) => {
            const task = f.tasks.find((t) => t.id === payload.id);
            if (!task) return f;
            task.status = payload.status;
            task.updatedAt = new Date().toISOString();
            return f;
          });
          sendResult(ws, true, `Task status updated to "${payload.status}".`);
          broadcast({
            type: 'tasks.updated',
            payload: { tasks: file.tasks },
          });
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      // Collaboration messages — the CLI webui-server doesn't run a
      // full collab hub; silently acknowledge and ignore.
      case 'collab.join':
      case 'collab.leave':
      case 'collab.annotate':
      case 'collab.resolve':
        break;

      case 'projects.list': {
        // Read the project manifest from ~/.wrongstack/projects.json
        const projectsBase = opts.globalConfigPath
          ? path.resolve(path.dirname(opts.globalConfigPath))
          : wstackGlobalRoot();
        const manifestPath = path.join(projectsBase, 'projects.json');
        try {
          const raw = await fs.readFile(manifestPath, 'utf8');
          const manifest = JSON.parse(raw) as {
            projects: Array<{ name: string; root: string; slug: string; lastSeen?: string }>;
          };
          send(ws, {
            type: 'projects.list',
            payload: { projects: manifest.projects ?? [] },
          });
        } catch {
          send(ws, { type: 'projects.list', payload: { projects: [] } });
        }
        break;
      }

      case 'projects.select': {
        // In-process project switch — mirrors the standalone server's handler:
        // re-root everything the handlers read at call time (opts.projectRoot,
        // agent ctx, session store), finalize the old session writer, start a
        // fresh session in the new project, and broadcast a reset
        // session.start so every client re-renders (sessions, file manager,
        // mailbox, context bar).
        //
        // An older version spawned a NEW interactive wstack with
        // stdio:'inherit' into the host's terminal and changed nothing in the
        // browser — the WebUI stayed on the old project.
        const { root, name: projectName } = (
          msg as { payload: { root: string; name?: string | undefined } }
        ).payload;
        try {
          const resolved = path.resolve(root);
          const stat = await fs.stat(resolved).catch(() => null);
          if (!stat?.isDirectory()) {
            send(ws, {
              type: 'projects.selected',
              payload: {
                root,
                name: projectName ?? path.basename(root),
                message: `Cannot switch: not a directory: ${resolved}`,
              },
            });
            break;
          }

          // Manifest: bump lastSeen, or auto-register an unknown root.
          const { loadManifest, saveManifest } = await import('./slash-commands/project-utils.js');
          const manifest = await loadManifest(opts.globalConfigPath);
          const entry = manifest.projects.find((p) => path.resolve(p.root) === resolved);
          const displayName = projectName?.trim() || entry?.name || path.basename(resolved);
          if (entry) {
            entry.lastSeen = new Date().toISOString();
          } else {
            manifest.projects.push({
              name: displayName,
              root: resolved,
              slug: projectSlug(resolved),
              lastSeen: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            });
          }
          await saveManifest(manifest, opts.globalConfigPath);

          // Abort any in-flight run — its context is about to be re-rooted.
          if (abortController) {
            abortController.abort();
            abortController = null;
          }
          // Also clear the per-socket controller for this switching client
          // so a subsequent `case 'abort'` from a reconnected socket starts
          // clean. We do NOT iterate other sockets' controllers — a project
          // switch is a server-wide state change and other sockets should see
          // it via the projects.list broadcast below, not be aborted.
          abortControllers.delete(ws);

          const ctx = opts.agent.ctx;
          const oldSessionId = ctx.session?.id ?? opts.session.id;

          // Finalize the writer we are leaving. Usage captured before the
          // counter reset below (the closure runs after it).
          const oldWriter = ctx.session;
          const oldUsage = ctx.tokenCounter.total();
          if (oldWriter) {
            void (async () => {
              await oldWriter
                .append({ type: 'session_end', ts: new Date().toISOString(), usage: oldUsage })
                .catch(() => undefined);
              await oldWriter.close().catch(() => undefined);
            })();
          }

          // Re-root: every handler resolves opts.projectRoot / ctx at call
          // time (files.*, mailbox.*, goal, …), so mutating these re-roots
          // them all without further plumbing.
          opts.projectRoot = resolved;
          ctx.cwd = resolved;
          ctx.projectRoot = resolved;

          // Rebuild the system prompt for the NEW project. The environment
          // block (project root, git status, languages) is baked into the
          // prompt at boot; without this rebuild the agent keeps the
          // launch-directory environment and tries to operate in the old
          // folder until tool errors correct it. Best-effort — a failure here
          // leaves the prior prompt rather than breaking the switch.
          try {
            const switchMode =
              opts.modeId && opts.modeId !== 'default' && opts.modeStore
                ? await opts.modeStore.getMode(opts.modeId)
                : undefined;
            const switchBuilder = new DefaultSystemPromptBuilder({
              memoryStore: opts.memoryStore,
              skillLoader: opts.skillLoader,
              modeStore: opts.modeStore,
              modeId: opts.modeId ?? 'default',
              modePrompt: switchMode?.prompt ?? '',
            });
            ctx.systemPrompt = await switchBuilder.build({
              cwd: resolved,
              projectRoot: resolved,
              tools: opts.agent.tools.list(),
              provider: (ctx.provider as { id?: string }).id,
              model: ctx.model,
            });
          } catch {
            /* best-effort — keep the prior system prompt if rebuild fails */
          }

          // Fresh per-project session store + session.
          const globalRoot = opts.globalConfigPath
            ? path.dirname(opts.globalConfigPath)
            : wstackGlobalRoot();
          const newSessionsDir = path.join(resolveProjectDir(resolved, globalRoot), 'sessions');
          await fs.mkdir(newSessionsDir, { recursive: true });
          const newStore = new DefaultSessionStore({ dir: newSessionsDir });
          opts.sessionStore = newStore;
          const newWriter = await newStore.create({
            id: '',
            title: '',
            model: ctx.model,
            provider: (ctx.provider as { id?: string }).id ?? '',
          });
          ctx.session = newWriter;
          opts.onSessionSwapped?.(newWriter.id);
          ctx.state.replaceMessages([]);
          ctx.state.replaceTodos([]);
          ctx.readFiles.clear();
          ctx.fileMtimes.clear();
          ctx.tokenCounter.reset();

          send(ws, {
            type: 'projects.selected',
            payload: {
              root: resolved,
              name: displayName,
              message: `Switched to ${displayName}`,
            },
          });
          // Full-state broadcast so ALL clients re-root their panels.
          const switchedP = await buildSessionStartPayload({
            reset: true,
            clearedSessionId: oldSessionId,
          });
          broadcast({ type: 'session.start', payload: switchedP });
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'projects.add': {
        // Register a folder in the project manifest (Projects panel "Add").
        // Ported from the standalone server — this message used to fall
        // through to "Unknown message type" here, so adding a project from
        // the WebUI silently did nothing on the embedded server.
        const { root: addRoot, name: addName } = (
          msg as { payload: { root: string; name?: string | undefined } }
        ).payload;
        try {
          const resolved = path.resolve(addRoot);
          const stat = await fs.stat(resolved).catch(() => null);
          if (!stat?.isDirectory()) throw new Error(`Not a directory: ${resolved}`);

          const { loadManifest, saveManifest, ensureProjectDataDir } = await import(
            './slash-commands/project-utils.js'
          );
          const manifest = await loadManifest(opts.globalConfigPath);
          const existing = manifest.projects.find((p) => path.resolve(p.root) === resolved);
          if (existing) {
            send(ws, {
              type: 'projects.added',
              payload: {
                name: existing.name,
                root: existing.root,
                slug: existing.slug,
                message: `Already registered as "${existing.name}"`,
              },
            });
            break;
          }
          const name = addName?.trim() || path.basename(resolved);
          const slug = projectSlug(resolved);
          await ensureProjectDataDir(slug, opts.globalConfigPath);
          const now = new Date().toISOString();
          manifest.projects.push({ name, root: resolved, slug, lastSeen: now, createdAt: now });
          await saveManifest(manifest, opts.globalConfigPath);
          send(ws, {
            type: 'projects.added',
            payload: { name, root: resolved, slug, message: `Registered project "${name}"` },
          });
        } catch (err) {
          send(ws, {
            type: 'projects.added',
            payload: {
              name: path.basename(addRoot),
              root: addRoot,
              slug: '',
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
        break;
      }

      case 'working_dir.set': {
        // FileExplorer breadcrumb navigation. Ported from the standalone
        // server (used to be an unknown message here).
        const { path: newPath } = (msg as { payload: { path: string } }).payload;
        try {
          const wdRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
          const resolved = path.resolve(wdRoot, newPath);
          if (!resolved.startsWith(wdRoot + path.sep) && resolved !== wdRoot) {
            sendResult(ws, false, `Path must stay inside the project root: ${wdRoot}`);
            break;
          }
          const stat = await fs.stat(resolved).catch(() => null);
          if (!stat?.isDirectory()) {
            sendResult(ws, false, `Directory not found or not accessible: ${resolved}`);
            break;
          }
          opts.agent.ctx.cwd = resolved;
          broadcast({
            type: 'working_dir.changed',
            payload: { cwd: resolved, projectRoot: wdRoot },
          });
          sendResult(ws, true, `Working directory set to ${resolved}`);
        } catch (err) {
          sendResult(ws, false, err instanceof Error ? err.message : String(err));
        }
        break;
      }

      case 'shell.open': {
        // Logic lives in `@wrongstack/webui/server`'s `shell-open.ts`
        // so the standalone and CLI entry points share the same
        // metacharacter guard + cross-platform spawn chain. See the
        // docstring in shell-open.ts for the security rationale and
        // the fallback chain. The CLI used to inline this 49-line
        // block (and lacked the spawn-failure logger.warn that the
        // standalone has) — this delegate brings them back in line.
        const result = await handleShellOpen(
          msg.payload as Parameters<typeof handleShellOpen>[0],
          consoleLogger,
        );
        sendResult(ws, result.success, result.message);
        break;
      }

      case 'model.refine': {
        const { text } = (msg as { payload: { text: string } }).payload;
        if (!text?.trim()) {
          send(ws, {
            type: 'model.refine_result',
            payload: { refined: '', english: '', error: 'Empty text' },
          });
          break;
        }
        try {
          const ctx = opts.agent.ctx;
          const history = recentTextTurns(ctx.messages);
          const result = await enhanceUserPrompt({
            provider: ctx.provider,
            model: ctx.model,
            text,
            history,
            timeoutMs: 90000,
            onError: (reason) => {
              console.warn(
                JSON.stringify({
                  level: 'warn',
                  event: 'model.refine_failed',
                  reason,
                  timestamp: new Date().toISOString(),
                }),
              );
            },
          });
          if (result) {
            send(ws, {
              type: 'model.refine_result',
              payload: { refined: result.refined, english: result.english },
            });
          } else {
            send(ws, {
              type: 'model.refine_result',
              payload: { refined: text, english: text, error: 'Refinement returned no result' },
            });
          }
        } catch (err) {
          send(ws, {
            type: 'model.refine_result',
            payload: {
              refined: text,
              english: text,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
        break;
      }

      case 'webui.shutdown':
        console.log('[WebUI] Shutdown requested from client');
        shutdown();
        break;

      // ── Mailbox operations — project-level inter-agent messaging ────
      case 'mailbox.messages': {
        const projectRoot =
          opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '';
        const globalRoot = opts.globalConfigPath ? path.dirname(opts.globalConfigPath) : '';
        if (!projectRoot || !globalRoot) {
          send(ws, {
            type: 'mailbox.messages',
            payload: { messages: [], error: 'No project root available' },
          });
          break;
        }
        try {
          // Single source of truth for the per-project dir — the inline slug
          // this replaced drifted from projectSlug() on edge-case names.
          const mbDir = resolveProjectDir(projectRoot, globalRoot);
          const mb = new GlobalMailbox(mbDir);
          const payload = (
            msg as { payload?: { limit?: number; agentId?: string; unreadOnly?: boolean } }
          ).payload;
          const messages = await mb.query({
            limit: payload?.limit ?? 30,
            to: payload?.agentId,
            unreadBy: payload?.unreadOnly ? payload.agentId : undefined,
          });
          send(ws, {
            type: 'mailbox.messages',
            payload: {
              messages: messages.map((m) => ({
                id: m.id,
                from: m.from,
                to: m.to,
                type: m.type,
                subject: m.subject,
                body: m.body,
                priority: m.priority,
                readBy: m.readBy,
                readByCount: Object.keys(m.readBy).length,
                completed: m.completed,
                completedBy: m.completedBy,
                outcome: m.outcome,
                timestamp: m.timestamp,
                replyTo: m.replyTo,
                senderSessionId: m.senderSessionId,
              })),
            },
          });
        } catch (err) {
          send(ws, {
            type: 'mailbox.messages',
            payload: { messages: [], error: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case 'mailbox.agents': {
        const projectRoot =
          opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '';
        const globalRoot = opts.globalConfigPath ? path.dirname(opts.globalConfigPath) : '';
        if (!projectRoot || !globalRoot) {
          send(ws, {
            type: 'mailbox.agents',
            payload: { agents: [], error: 'No project root available' },
          });
          break;
        }
        try {
          // Single source of truth for the per-project dir — the inline slug
          // this replaced drifted from projectSlug() on edge-case names.
          const mbDir = resolveProjectDir(projectRoot, globalRoot);
          const mb = new GlobalMailbox(mbDir);
          const payload = (msg as { payload?: { onlineOnly?: boolean } }).payload;
          const agents = payload?.onlineOnly
            ? await mb.getOnlineAgents()
            : await mb.getAgentStatuses();
          send(ws, {
            type: 'mailbox.agents',
            payload: {
              agents: agents.map((a) => ({
                agentId: a.agentId,
                name: a.name,
                role: a.role,
                sessionId: a.sessionId,
                status: a.status,
                currentTool: a.currentTool,
                currentTask: a.currentTask,
                iterations: a.iterations,
                toolCalls: a.toolCalls,
                lastSeenAt: a.lastSeenAt,
                online: a.online,
                pid: a.pid,
                source: a.source,
              })),
            },
          });
        } catch (err) {
          send(ws, {
            type: 'mailbox.agents',
            payload: { agents: [], error: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      case 'mailbox.clear': {
        const projectRoot =
          opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '';
        const globalRoot = opts.globalConfigPath ? path.dirname(opts.globalConfigPath) : '';
        if (!projectRoot || !globalRoot) {
          send(ws, { type: 'mailbox.cleared', payload: { error: 'No project root available' } });
          break;
        }
        try {
          // Single source of truth for the per-project dir — the inline slug
          // this replaced drifted from projectSlug() on edge-case names.
          const mbDir = resolveProjectDir(projectRoot, globalRoot);
          const mb = new GlobalMailbox(mbDir);
          await mb.clearAll();
          send(ws, { type: 'mailbox.cleared', payload: {} });
        } catch (err) {
          send(ws, {
            type: 'mailbox.cleared',
            payload: { error: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      }

      default: {
        // Delegate AutoPhase lifecycle messages to the AutoPhase handler.
        // If the message type starts with 'autophase.', forward it; otherwise
        // log it as unhandled.
        const msgType = (msg as { type: string }).type;
        if (msgType.startsWith('autophase.')) {
          await autoPhaseHandler.handleMessage(
            msg as { type: string; payload?: Record<string, unknown> },
          );
        } else {
          console.debug(`[WebUI] Unhandled message type: ${msgType}`);
        }
        break;
      }
    }
  }

  async function handleUserMessage(
    ws: WebSocket,
    _client: ConnectedClient,
    content: string,
  ): Promise<void> {
    // Guard against overlapping runs on the same Agent instance. Two
    // rapid user messages would otherwise start a second agent.run()
    // before the first one's cleanup settles, corrupting context state.
    // Scoped to the requesting socket via `abortControllers` — a second
    // tab's `user_message` is allowed to start its own run; only an
    // overlapping message from the SAME tab is rejected.
    if (abortControllers.has(ws)) {
      send(ws, {
        type: 'error',
        payload: { phase: 'agent.run', message: 'A run is already in progress. Abort it first.' },
      });
      return;
    }

    // Abort any existing run (safety net; the guard above makes this
    // unreachable in the overlapping case, but direct abort requests
    // from the client still need the controller reference).
    const wsAbort = new AbortController();
    abortControllers.set(ws, wsAbort);

    try {
      const result = await opts.agent.run(content, {
        signal: wsAbort.signal,
      });

      send(ws, {
        type: 'run.result',
        payload: {
          status: result.status,
          iterations: result.iterations,
          finalText: result.finalText,
          error: result.error
            ? {
                code: result.error.code,
                message: result.error.message,
                recoverable: result.error.recoverable,
              }
            : undefined,
        },
      });
    } catch (err) {
      send(ws, {
        type: 'error',
        payload: {
          phase: 'agent.run',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      abortControllers.delete(ws);
    }
  }

  function send(ws: WebSocket, msg: WSServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function shutdown(): void {
    console.log('[WebUI] Shutting down...');
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
} // end of runWebUI
