import { expectDefined, GlobalMailbox, projectSlug, getSessionRegistry, AgentStatusTracker } from '@wrongstack/core';
import { makeMailboxTool, makeMailSendTool, makeMailInboxTool, mailboxSessionTag } from '@wrongstack/core';
import {
  BrainMonitor,
  DefaultBrainArbiter,
  ObservableBrainArbiter,
  createAutonomyBrain,
  createTieredBrainArbiter,
  type BrainArbiter,
  type BrainAutoRisk,
} from '@wrongstack/core';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHttpServer } from './http-server.js';
import {
  handleFilesTree,
  handleFilesRead,
  handleFilesWrite,
  handleFilesList,
} from './file-handlers.js';
import {
  handleMemoryList,
  handleMemoryRemember,
  handleMemoryForget,
} from './memory-handlers.js';
import {
  Agent,
  AutoCompactionMiddleware,
  Context,
  DefaultMemoryStore,
  DefaultModeStore,
  DefaultModelsRegistry,
  DefaultSessionReader,
  DefaultSessionStore,
  DefaultSkillLoader,
  DefaultSystemPromptBuilder,
  DefaultTokenCounter,
  AnnotationsStore,
  CollaborationBus,
  collabPauseMiddleware,
  collabInjectMiddleware,
  estimateRequestTokensCalibrated,
  EventBus,
  createStrategyCompactor,
  type ProviderConfig,
  type Provider,
  ProviderRegistry,
  TOKENS,
  ToolRegistry,
  atomicWrite,
  createDefaultPipelines,
  createSessionEventBridge,
  resolveSessionLoggingConfig,
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  DEFAULT_SESSION_PRUNE_DAYS,
  DEFAULT_TOOLS_CONFIG,
  listContextWindowModes,
  repairToolUseAdjacency,
  resolveContextWindowPolicy,
  enhanceUserPrompt,
  recentTextTurns,
} from '@wrongstack/core';
import { ToolExecutor } from '@wrongstack/core/execution';
import { decryptConfigSecrets, encryptConfigSecrets } from '@wrongstack/core/security';
import { buildProviderFactoriesFromRegistry, makeProviderFromConfig } from '@wrongstack/providers';
import { builtinToolsPack, forgetTool, rememberTool, searchMemoryTool, relatedMemoryTool } from '@wrongstack/tools';
import { type WebSocket, WebSocketServer } from 'ws';
import { createDefaultContainer } from '../../../runtime/src/container.js';
import { bootConfig, patchConfig } from './boot.js';
import { AutoPhaseWebSocketHandler } from './autophase-ws-handler.js';
import { CollaborationWebSocketHandler } from './collaboration-ws-handler.js';
import { WorktreeWebSocketHandler } from './worktree-ws-handler.js';
import { handleMailboxMessages, handleMailboxAgents, handleMailboxClear } from './mailbox-handlers.js';
import { verifyClient as verifyWsClient } from './ws-auth.js';
import { registerShutdownHandlers } from './lifecycle.js';
import { registerInstance, unregisterInstance } from './instance-registry.js';
import { findFreePort } from './port-utils.js';
import { openBrowser } from './open-browser.js';
import { computeUsageCost, getCostRates } from './usage-cost.js';
import { createProviderHandlers } from './provider-handlers.js';
import { setupEvents } from './setup-events.js';
import { createCustomModeStore } from './custom-context-modes.js';
import { maskedKey, normalizeKeys } from './provider-keys.js';
import { send, broadcast, sendResult, errMessage, generateAuthToken } from './ws-utils.js';
import { estimateContextBreakdown } from './token-estimator.js';
import { createEternalSubscription } from './eternal-iteration-broadcast.js';
import { handleShellOpen, type ShellOpenRequest, type ShellOpenResult } from './shell-open.js';
// Re-export types — shared message shapes and options used by both the
// standalone server and the CLI's `--webui` embedded mode.
export type { WebUIOptions, BackendServices } from './types.js';
export type { WSServerMessage, WSClientMessage, ConnectedClient } from './types.js';

// Re-export the static-serve + multi-instance building blocks so other packages
// (the CLI's `--webui` mode) can serve the same React frontend, inject the live
// WS port, pick free ports, and register in the shared instance registry —
// without duplicating any of that logic.
export { createHttpServer, buildCspHeader, injectWsPort } from './http-server.js';
export { findFreePort, isPortFree } from './port-utils.js';
export { openBrowser, browserOpenCommand } from './open-browser.js';
// Token estimator primitives — exposed for the CLI's embedded webui
// (which historically inlined its own copy and let it drift). Now
// there's exactly one definition. See
// packages/cli/src/webui-server.ts Phase 2 of the refactor plan.
export {
  estimateTokens,
  messageTokens,
  messagePreview,
  stringifyContent,
  type ContextBreakdown,
  type MessageTokenEntry,
  type ToolTokenEntry,
} from './token-estimator.js';
export {
  registerInstance,
  unregisterInstance,
  listInstances,
  formatInstances,
  registryPath,
  defaultBaseDir,
  type WebUIInstanceRecord,
} from './instance-registry.js';

// WebSocket utilities shared with CLI
export {
  createEternalSubscription,
  type EternalSubscribe,
  type EternalBroadcast,
  type EternalSubscription,
} from './eternal-iteration-broadcast.js';
export {
  handleShellOpen,
  type ShellOpenRequest,
  type ShellOpenResult,
  type ShellOpenTarget,
} from './shell-open.js';
export {
  send,
  broadcast,
  sendResult,
  errMessage,
  generateAuthToken,
} from './ws-utils.js';

// File operation handlers shared with CLI (files.tree, files.read, files.write, files.list)
export {
  handleFilesTree,
  handleFilesRead,
  handleFilesWrite,
  handleFilesList,
} from './file-handlers.js';

// Memory operation handlers shared with CLI (memory.list, memory.remember, memory.forget)
export {
  handleMemoryList,
  handleMemoryRemember,
  handleMemoryForget,
} from './memory-handlers.js';

// Custom context-mode store shared with the CLI's embedded server
// (context.mode.create/update/delete + custom-aware list/switch).
export {
  createCustomModeStore,
  type CustomModeStore,
  type CustomContextMode,
} from './custom-context-modes.js';

// WS auth — pure functions for verifying WebSocket connections
export {
  verifyClient,
  isLoopbackHostname,
  isLoopbackBind,
  tokenMatches,
  extractToken,
  hostHeaderOk,
  type VerifyClientInput,
} from './ws-auth.js';

// Provider/API-key record transforms (pure functions, testable without I/O)
export {
  normalizeKeys,
  writeKeysBack,
  maskedKey,
  upsertKey,
  deleteKey,
  setActiveKey,
  addProvider,
  removeProvider,
  type KeyOpResult,
  type ProvidersRecord,
} from './provider-keys.js';

// Provider config load/save (decrypt from / encrypt to global config)
export {
  loadSavedProviders,
  saveProviders,
  createProviderConfigIO,
} from './provider-config-io.js';

// AutoPhase WebSocket handler — manages AutoPhase lifecycle via WS messages.
// Exported so the CLI's embedded webui-server can also handle autophase.*
// messages when running in --webui mode.
export { AutoPhaseWebSocketHandler } from './autophase-ws-handler.js';

// Message + client shapes now live in ./types.ts (shared with the CLI's
// embedded server). Imported here for internal use; re-exported above for
// external consumers. The previous local copies shadowed these and made the
// `Map<WebSocket, ConnectedClient>` passed to the extracted ws-utils helpers
// nominally distinct, which TS rejected.
import type { ConnectedClient, WSClientMessage, WSServerMessage, WebUIOptions } from './types.js';

export async function startWebUI(
  opts: WebUIOptions & {
    wsPort?: number | undefined;
    wsHost?: string | undefined;
    open?: boolean | undefined;
  } = {},
): Promise<void> {
  const requestedWsPort = opts.wsPort ?? 3457;
  // Bind to loopback IP by default (not the string "localhost", which on some
  // hosts resolves to IPv6 ::1 and surprises older WS clients). Set WS_HOST or
  // pass opts.wsHost to override (e.g. "0.0.0.0" for LAN access).
  const wsHost = opts.wsHost ?? '127.0.0.1';
  const requestedHttpPort = Number.parseInt(process.env['PORT'] ?? '3456', 10);

  // Port resolution. Unless WEBUI_STRICT_PORT is set, auto-advance past any port
  // already taken by another instance so running `webui` several times "just
  // works" — the real ports are then stamped into the served HTML and the
  // instance registry. Strict mode keeps the requested ports and lets bind fail
  // loudly (useful behind a reverse proxy that expects fixed ports).
  const strictPort =
    process.env['WEBUI_STRICT_PORT'] === '1' || process.env['WEBUI_STRICT_PORT'] === 'true';
  let wsPort = requestedWsPort;
  let httpPort = requestedHttpPort;
  if (!strictPort) {
    // Resolve HTTP first, then WS excluding it, so successive instances land on
    // tidy adjacent pairs (3456/3457, 3458/3459, …) instead of interleaving.
    httpPort = await findFreePort(wsHost, requestedHttpPort);
    wsPort = await findFreePort(wsHost, requestedWsPort, { exclude: new Set([httpPort]) });
    if (httpPort !== requestedHttpPort) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'webui.port_reassigned',
        protocol: 'HTTP',
        requested: requestedHttpPort,
        assigned: httpPort,
        timestamp: new Date().toISOString(),
      }));
    }
    if (wsPort !== requestedWsPort) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'webui.port_reassigned',
        protocol: 'WS',
        requested: requestedWsPort,
        assigned: wsPort,
        timestamp: new Date().toISOString(),
      }));
    }
  }

  console.log('[WebUI] Starting backend services...');

  // Boot configuration
  const boot = await bootConfig();
  const { config: baseConfig, globalConfigPath, wpaths, logger } = boot;
  // PR 5 of Phase 2: when the caller (typically the CLI) supplies a
  // pre-built `BackendServices`, prefer its `vault` over the one the
  // default boot would construct. This lets `runWebUI` keep owning the
  // vault lifecycle (so it can decrypt/encrypt its own config writes
  // in lockstep with the rest of the CLI session) instead of having
  // the webui build a parallel vault it can never see.
  const vault = opts.services?.vault ?? boot.vault;
  let config = baseConfig;

  /** Mutable project root — updated on `projects.select`. File handlers,
   *  sessionStartPayload, and session store use this value. */
  let projectRoot = boot.projectRoot;
  /** Mutable working directory — starts at projectRoot, changeable via
   *  `working_dir.set` WS message. Must always stay inside projectRoot. */
  let workingDir = projectRoot;

  // Serialize concurrent config writes to prevent races between model.switch
  // and key.add/key.update handlers that both read-modify-write globalConfigPath.
  let configWriteLock: Promise<void> = Promise.resolve();

  console.log('[WebUI] Config loaded:', config.provider ?? '(none)', '/', config.model ?? '(none)');

  // If no active provider is set but there are saved providers, pick the first one.
  // This handles configs written in older formats or by external tools.
  // Guard against config.providers being a string or other non-object value
  // (e.g., from a corrupted config or YAML parser misreading the value).
  if (
    !config.provider &&
    config.providers &&
    typeof config.providers === 'object' &&
    config.providers !== null &&
    !Array.isArray(config.providers) &&
    Object.keys(config.providers).length > 0
  ) {
    const firstKey = expectDefined(Object.keys(config.providers)[0]);
    config = patchConfig(config, { provider: firstKey });
    console.log('[WebUI] No active provider — auto-selected:', firstKey);
  }

  // If still no provider, the frontend will show a no-provider welcome screen.
  // We still start the HTTP/WS servers so the user can configure via the UI.
  const needsProvider = !config.provider || !config.model;

  // ModelsRegistry — use injected one if `services.modelsRegistry` was passed,
  // otherwise build a fresh one. The injected path lets the CLI's `runWebUI`
  // share a single registry across its own runtime and the webui surface.
  const modelsRegistry =
    opts.services?.modelsRegistry ??
    new DefaultModelsRegistry({
      cacheFile: wpaths.modelsCache,
      ttlSeconds: 24 * 3600,
    });

  // Container via shared factory
  const container = createDefaultContainer({ config, wpaths, logger, modelsRegistry });
  // PR 5 of Phase 2: when the caller (typically the CLI) supplies a
  // pre-built `BackendServices`, prefer its `configStore` over the one
  // the default container would resolve. This is the read+write
  // counterpart of the `vault` injection above: together they let
  // `runWebUI` own the global config lifecycle and have the webui
  // operate on the *same* in-memory store, so a `provider.switch`
  // from the webui is visible to the CLI's next call without a disk
  // round-trip in between.
  const configStore = opts.services?.configStore ?? container.resolve(TOKENS.ConfigStore);

  // Provider registry
  const providerRegistry = new ProviderRegistry();
  try {
    const factories = await buildProviderFactoriesFromRegistry({
      registry: modelsRegistry,
      log: logger,
    });
    for (const f of factories) providerRegistry.register(f);
    console.log('[WebUI] Provider registry loaded:', providerRegistry.list().length, 'providers');
  } catch (err) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'webui.provider_registry_load_failed',
      message: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }));
  }

  // Tool registry — use injected one if `services.toolRegistry` was passed.
  // When injected, the caller has already registered the tools they want
  // (the CLI's runWebUI registers its own runtime tools); startWebUI just
  // uses the registry as-is.
  const toolRegistry =
    opts.services?.toolRegistry ??
    (() => {
      const r = new ToolRegistry();
      r.registerAllOrThrow([...(builtinToolsPack.tools ?? [])], builtinToolsPack.name);
      return r;
    })();

  // Memory tools
  const memoryStore = new DefaultMemoryStore({ paths: wpaths });
  if (config.features.memory) {
    toolRegistry.register(rememberTool(memoryStore));
    toolRegistry.register(forgetTool(memoryStore));
    toolRegistry.register(searchMemoryTool(memoryStore));
    toolRegistry.register(relatedMemoryTool(memoryStore));
  }

  // Event bus — use injected one if `services.events` was passed. The CLI's
  // runWebUI owns the agent's EventBus so it can wire sub-agents onto the
  // same bus the webui dashboard reads from. When injected, we just
  // attach the logger and reuse the existing instance.
  const events = opts.services?.events ?? new EventBus();
  events.setLogger(logger);

  // Inter-agent mailbox tools — same project-level GlobalMailbox the CLI
  // registers, keyed by wpaths.projectDir so WebUI agents and terminal
  // agents on the same project share one inbox and can chat/broadcast.
  // mail_send/mail_inbox are the high-affordance thin wrappers.
  toolRegistry.register(makeMailboxTool({ projectDir: wpaths.projectDir, events }));
  toolRegistry.register(makeMailSendTool({ projectDir: wpaths.projectDir, events }));
  toolRegistry.register(makeMailInboxTool({ projectDir: wpaths.projectDir, events }));
  console.log('[WebUI] Tool registry loaded:', toolRegistry.list().length, 'tools');

  // Session store — mutable so projects.select can swap it to the new project's dir.
  // Use the injected one if `services.session` was passed. The CLI's
  // runWebUI already has its own session store pointing at the
  // right per-project dir; we reuse it here so the webui reads
  // the same history the CLI is writing.
  let sessionStore = opts.services?.session ?? new DefaultSessionStore({ dir: wpaths.projectSessions });
  // Prune old sessions on server start (non-blocking). Skipped when
  // an injected store is in use — the CLI's eternal loop is
  // responsible for its own lifecycle and pruning an in-use store
  // would race with the CLI's own prune policy.
  if (!opts.services?.session) {
    sessionStore
      .prune(DEFAULT_SESSION_PRUNE_DAYS)
      .then((count) => {
        if (count > 0) logger.info(`Pruned ${count} old session${count === 1 ? '' : 's'}.`);
      })
      .catch(() => undefined);
  }
  // Session reader — same on-disk store, read-only access. Used by the
  // collaboration handler to replay the last N events to late-joining
  // observers (Phase 1.5 of idea #13).
  const sessionReader = new DefaultSessionReader({ store: sessionStore });
  // Annotations store — sidecar files for collaboration notes (Phase 2
  // of idea #13). Living under `projectSessions` so all per-session
  // data is colocated and travels with the project.
  const annotationsStore = new AnnotationsStore({ dir: wpaths.projectSessions });
  let session = await sessionStore.create({
    id: '',
    title: '',
    model: config.model,
    provider: config.provider,
  });
  // Wall-clock when the *current* session started. Updated on /new and on
  // /resume so /stats can report accurate elapsed time per the active
  // session, not the daemon process uptime.
  let sessionStartedAt = Date.now();
  console.log('[WebUI] Session created:', session.id);

  // ── Cross-surface discovery ──────────────────────────────────────────
  // (1) Register/refresh this project in ~/.wrongstack/projects.json so
  // pickers and other surfaces see it regardless of which interface
  // opened it first. (2) Register this session in the cross-process
  // SessionRegistry so terminals' `/sessions status` lists this WebUI
  // (and vice versa). Both best-effort — discovery must not block boot.
  try {
    await touchProjectEntry(projectRoot, workingDir);
  } catch { /* best-effort */ }
  let statusTracker: AgentStatusTracker | undefined;
  try {
    const registry = getSessionRegistry(wpaths.globalRoot);
    await registry.register({
      sessionId: session.id,
      projectSlug: wpaths.projectSlug,
      projectRoot,
      projectName: path.basename(projectRoot),
      workingDir,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    statusTracker = new AgentStatusTracker({ events, registry });
    statusTracker.start();
    const stopTracking = async () => {
      try {
        await registry.markClosing();
        statusTracker?.stop();
      } catch { /* ignore */ }
    };
    process.once('beforeExit', () => { void stopTracking(); });
    process.once('SIGINT', () => { void stopTracking(); });
    process.once('SIGTERM', () => { void stopTracking(); });
  } catch { /* best-effort — discovery degrades gracefully */ }

  // Token counter
  const tokenCounter = new DefaultTokenCounter({
    registry: modelsRegistry,
    providerId: config.provider,
  });

  // Mode store
  const modeStore = new DefaultModeStore({ directory: wpaths.configDir });
  const activeMode = await modeStore.getActiveMode();
  let modeId = activeMode?.id ?? 'default';
  const modePrompt = activeMode?.prompt ?? '';

  // Custom context modes store — user-defined presets persisted to disk.
  // Loaded once on startup; merges with built-in modes in the list handler.
  const customModeStore = createCustomModeStore(wpaths.configDir);
  await customModeStore.load();
  console.log(
    '[WebUI] Custom context modes loaded:',
    customModeStore.list().filter((m) => (m as { custom?: boolean }).custom).length,
    'custom',
  );

  // System prompt builder
  const resolvedModel = await modelsRegistry.getModel(config.provider, config.model);
  const modelCapabilities = resolvedModel?.capabilities
    ? {
        maxContextTokens: resolvedModel.capabilities.maxContext,
        supportsTools: resolvedModel.capabilities.tools,
        supportsVision: resolvedModel.capabilities.vision,
        supportsReasoning: resolvedModel.capabilities.reasoning,
      }
    : undefined;

  const skillLoader = config.features.skills
    ? new DefaultSkillLoader({ paths: wpaths })
    : undefined;
  const systemPromptBuilder = new DefaultSystemPromptBuilder({
    memoryStore,
    skillLoader,
    modeStore,
    modeId,
    modePrompt,
    modelCapabilities,
  });

  // Fetch online agents from the shared mailbox to include in system prompt
  let onlineAgents: import('@wrongstack/core').MailboxAgentStatus[] = [];
  try {
    const systemMailbox = new GlobalMailbox(wpaths.projectDir);
    onlineAgents = await systemMailbox.getAgentStatuses();
  } catch {
    // Non-fatal — mailbox errors should not block prompt building
  }

  const systemPrompt = await systemPromptBuilder.build({
    cwd: projectRoot,
    projectRoot,
    tools: toolRegistry.list(),
    provider: config.provider,
    model: config.model,
    onlineAgents,
  });

  // Build provider (only if provider is configured)
  let provider: ReturnType<ProviderRegistry['create']>;
  if (!needsProvider) {
    const providerConfig = config.providers?.[config.provider] ?? {
      type: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
    try {
      const cfgWithType = { ...providerConfig, type: config.provider };
      if (config.features.modelsRegistry && providerRegistry.has(config.provider)) {
        provider = providerRegistry.create(cfgWithType);
      } else {
        provider = makeProviderFromConfig(config.provider, cfgWithType);
      }
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'webui.provider_create_failed',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }));
      throw err;
    }
  } else {
    // No provider is actively selected, but saved providers exist.
    // Re-read the config to find one with a usable encrypted API key
    // and create a real provider from it (the vault is already initialized).
    const savedProviders = config.providers ?? {};
    const firstKey = Object.keys(savedProviders)[0];
    if (firstKey) {
      const firstProvider = expectDefined(savedProviders[firstKey]);
      try {
        provider = makeProviderFromConfig(firstKey, {
          ...firstProvider,
          type: firstKey,
          family: firstProvider.family,
          apiKey: firstProvider.apiKey,
        });
        console.log('[WebUI] Using saved provider:', firstKey);
      } catch (err) {
        console.error(JSON.stringify({
          level: 'error',
          event: 'webui.provider_stub_create_failed',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }));
        throw err;
      }
    } else {
      throw new Error(
        'No provider configured. Run `wrongstack init` first, or configure via the WebUI.',
      );
    }
  }

  // Context
  const context = new Context({
    systemPrompt,
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter,
    cwd: workingDir,
    projectRoot,
    model: config.model,
  });
  const initialContextPolicy = resolveContextWindowPolicy(config.context);
  context.meta['contextWindowMode'] = initialContextPolicy.id;
  context.meta['contextWindowPolicy'] = initialContextPolicy;

  // ── Seed runtime prefs from config ──────────────────────────────────────
  // The settings panel reads prefs via `prefs.get` → context.meta. Without
  // this seed the snapshot is empty and every browser shows localStorage
  // defaults (autonomy "off", etc.) regardless of what config.json says.
  // Mirrors the CLI's getSettings() mapping so TUI and WebUI agree.
  {
    const autonomyCfg = (config.autonomy ?? {}) as Record<string, unknown>;
    const rawMode = autonomyCfg['defaultMode'];
    context.meta['autonomy'] =
      rawMode === 'suggest' || rawMode === 'auto' ? rawMode : 'off';
    context.meta['autonomyDelayMs'] = (autonomyCfg['autoProceedDelayMs'] as number) ?? 45_000;
    context.meta['autoProceedMaxIterations'] =
      (autonomyCfg['autoProceedMaxIterations'] as number) ?? 50;
    context.meta['yolo'] = (autonomyCfg['yolo'] as boolean) ?? config.yolo ?? false;
    context.meta['chime'] = (autonomyCfg['chime'] as boolean) ?? false;
    context.meta['confirmExit'] = autonomyCfg['confirmExit'] !== false;
    context.meta['streamFleet'] = autonomyCfg['streamFleet'] !== false;
    context.meta['enhanceEnabled'] = (autonomyCfg['enhance'] as boolean) ?? true;
    context.meta['enhanceDelayMs'] = (autonomyCfg['enhanceDelayMs'] as number) ?? 60_000;
    context.meta['enhanceLanguage'] = (autonomyCfg['enhanceLanguage'] as string) ?? 'original';
    context.meta['nextPrediction'] = config.nextPrediction ?? false;
    context.meta['featureMcp'] = config.features.mcp !== false;
    context.meta['featurePlugins'] = config.features.plugins !== false;
    context.meta['featureMemory'] = config.features.memory !== false;
    context.meta['featureSkills'] = config.features.skills !== false;
    context.meta['featureModelsRegistry'] = config.features.modelsRegistry !== false;
    context.meta['indexOnStart'] = config.indexing?.onSessionStart !== false;
    context.meta['contextAutoCompact'] = config.context?.autoCompact !== false;
    context.meta['contextStrategy'] = config.context?.strategy ?? 'hybrid';
    context.meta['logLevel'] = config.log?.level ?? 'info';
    context.meta['auditLevel'] = config.session?.auditLevel ?? 'standard';
    context.meta['maxIterations'] = config.tools?.maxIterations ?? 500;
  }

  /** Pref keys exposed to the settings panel via prefs.get / prefs.updated. */
  const PREF_KEYS = [
    'autonomy', 'autonomyDelayMs', 'autoProceedMaxIterations', 'yolo', 'maxIterations',
    'chime', 'confirmExit', 'streamFleet', 'nextPrediction',
    'enhanceEnabled', 'enhanceDelayMs', 'enhanceLanguage',
    'featureMcp', 'featurePlugins', 'featureMemory', 'featureSkills',
    'featureModelsRegistry', 'indexOnStart',
    'contextAutoCompact', 'contextStrategy', 'logLevel', 'auditLevel',
  ] as const;

  const prefSnapshot = (): Record<string, unknown> => {
    const snapshot: Record<string, unknown> = {};
    for (const k of PREF_KEYS) {
      if (k in context.meta) snapshot[k] = context.meta[k];
    }
    return snapshot;
  };

  /**
   * Persist pref changes into the global config.json — the SAME keys the
   * TUI settings picker writes — so a toggle made in the browser survives
   * restarts and is visible to the CLI/TUI (and vice versa on next boot).
   * Best-effort and serialized behind configWriteLock (shared with the
   * provider/key handlers); failures log but never break the WS reply.
   */
  const persistPrefsToConfig = async (payload: Record<string, unknown>): Promise<void> => {
    const write = async (): Promise<void> => {
      let raw: string;
      try {
        raw = await fs.readFile(globalConfigPath, 'utf8');
      } catch {
        raw = '{}';
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Refuse to overwrite a corrupt-but-existing config.
        logger.warn(`prefs: refusing to overwrite corrupt config at ${globalConfigPath}`);
        return;
      }
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
      if (typeof payload['autonomyDelayMs'] === 'number') setAutonomy('autoProceedDelayMs', payload['autonomyDelayMs']);
      if (typeof payload['autoProceedMaxIterations'] === 'number') setAutonomy('autoProceedMaxIterations', payload['autoProceedMaxIterations']);
      if (typeof payload['yolo'] === 'boolean') setAutonomy('yolo', payload['yolo']);
      if (typeof payload['chime'] === 'boolean') setAutonomy('chime', payload['chime']);
      if (typeof payload['confirmExit'] === 'boolean') setAutonomy('confirmExit', payload['confirmExit']);
      if (typeof payload['streamFleet'] === 'boolean') setAutonomy('streamFleet', payload['streamFleet']);
      if (typeof payload['enhanceEnabled'] === 'boolean') setAutonomy('enhance', payload['enhanceEnabled']);
      if (typeof payload['enhanceDelayMs'] === 'number') setAutonomy('enhanceDelayMs', payload['enhanceDelayMs']);
      if (typeof payload['enhanceLanguage'] === 'string') setAutonomy('enhanceLanguage', payload['enhanceLanguage']);
      if (autonomyTouched) decrypted.autonomy = autonomyCfg;

      if (typeof payload['nextPrediction'] === 'boolean') decrypted.nextPrediction = payload['nextPrediction'];

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

      if (typeof payload['contextAutoCompact'] === 'boolean' || typeof payload['contextStrategy'] === 'string') {
        const ctxCfg = (decrypted.context as Record<string, unknown>) ?? {};
        if (typeof payload['contextAutoCompact'] === 'boolean') ctxCfg.autoCompact = payload['contextAutoCompact'];
        if (typeof payload['contextStrategy'] === 'string') ctxCfg.strategy = payload['contextStrategy'];
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
      await atomicWrite(globalConfigPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
    };
    const next = configWriteLock.then(write);
    configWriteLock = next.then(
      () => undefined,
      () => undefined,
    );
    try {
      await next;
    } catch (err) {
      logger.warn(`prefs: failed to persist to config: ${errMessage(err)}`);
    }
  };

  // Pipelines
  const pipelines = createDefaultPipelines();
  // Collaboration bus — process-singleton pause/resume signal. The
  // middleware below hooks it into the toolCall pipeline so a
  // `controller` participant can halt the agent before the next tool
  // call (Phase 3 of idea #13). The same bus instance is shared with
  // the CollaborationWebSocketHandler so client pause/resume requests
  // are routed to the kernel.
  const collabBus = new CollaborationBus();
  // prepend (not use) — the pause check must run first, before any
  // permission/retry middleware that would otherwise proceed.
  const collabPause = collabPauseMiddleware(collabBus, { logger });
  Object.defineProperty(collabPause, 'name', { value: 'collab-pause' });
  pipelines.toolCall.prepend(collabPause as never);
  // Phase 4 — collab-inject. Installed AFTER collab-pause so the
  // controller can pause + inject before the next tool runs. The
  // middleware checks the bus's injection queue and splices a
  // synthetic tool_result when a controller has queued one for
  // the current toolUse.id.
  const collabInject = collabInjectMiddleware(collabBus, { logger });
  Object.defineProperty(collabInject, 'name', { value: 'collab-inject' });
  pipelines.toolCall.prepend(collabInject as never);
  // Compactor — honors config.context.strategy ('hybrid' default, lossless
  // rules; 'intelligent'/'selective' resolve their provider from ctx at
  // compact()-time). eliseThreshold is a TOKEN COUNT (not a fraction).
  const compactor = createStrategyCompactor({
    strategy: config.context?.strategy,
    preserveK: config.context?.preserveK ?? 10,
    eliseThreshold: config.context?.eliseThreshold ?? 2000,
    summarizerModel: config.context?.summarizerModel,
    llmSelector: config.context?.llmSelector,
  });

  // Auto-compaction
  let autoCompactor: AutoCompactionMiddleware | undefined;
  if (config.context?.autoCompact !== false) {
    // Priority: explicit override → models.dev per-model window → family default.
    // The catalog lookup matters for openai-compatible providers (OpenRouter,
    // Groq, …) whose family default is 0; without it auto-compaction would be
    // disabled even though the model has a real published window. Mirrors
    // updateAutoCompactionMaxContext below.
    let effectiveMaxContext = config.context?.effectiveMaxContext ?? 0;
    if (!effectiveMaxContext) {
      try {
        const m = await modelsRegistry.getModel(provider.id, context.model);
        effectiveMaxContext = m?.capabilities?.maxContext ?? 0;
      } catch {
        // best-effort: fall through to provider capability
      }
    }
    if (!effectiveMaxContext) effectiveMaxContext = provider.capabilities.maxContext;
    autoCompactor = new AutoCompactionMiddleware(
      compactor,
      effectiveMaxContext,
      (ctx) =>
        estimateRequestTokensCalibrated(
          ctx.messages,
          ctx.systemPrompt,
          ctx.tools ?? [],
          `${ctx.provider?.id ?? 'unknown'}/${ctx.model}`,
        ).total,
      {
        warn: initialContextPolicy.thresholds.warn,
        soft: initialContextPolicy.thresholds.soft,
        hard: initialContextPolicy.thresholds.hard,
      },
      {
        events,
        aggressiveOn: initialContextPolicy.aggressiveOn,
        policyProvider: (ctx) => {
          const policy = ctx.meta['contextWindowPolicy'];
          return policy && typeof policy === 'object'
            ? (policy as ReturnType<typeof resolveContextWindowPolicy>)
            : initialContextPolicy;
        },
      },
    );
    pipelines.contextWindow.use({ name: 'AutoCompaction', handler: autoCompactor.handler() });
  }

  /** Refresh AutoCompactionMiddleware denominator when the active model changes. */
  async function updateAutoCompactionMaxContext(newProvider: Provider): Promise<void> {
    if (!autoCompactor) return;
    let newMaxContext = config.context?.effectiveMaxContext ?? newProvider.capabilities.maxContext;
    try {
      const m = await modelsRegistry.getModel(newProvider.id, context.model);
      newMaxContext = m?.capabilities?.maxContext ?? newMaxContext;
    } catch {
      // best-effort: use provider capability
    }
    autoCompactor.setMaxContext(newMaxContext);
  }

  // Agent
  const secretScrubber = container.resolve(TOKENS.SecretScrubber);
  const renderer = container.has(TOKENS.Renderer) ? container.resolve(TOKENS.Renderer) : undefined;
  const permissionPolicy = container.resolve(TOKENS.PermissionPolicy);
  const toolExecutor = new ToolExecutor(toolRegistry, {
    permissionPolicy,
    secretScrubber,
    renderer,
    events,
    confirmAwaiter: undefined,
    iterationTimeoutMs: config.tools?.iterationTimeoutMs ?? DEFAULT_TOOLS_CONFIG.iterationTimeoutMs,
    perIterationOutputCapBytes:
      config.tools?.perIterationOutputCapBytes ?? DEFAULT_TOOLS_CONFIG.perIterationOutputCapBytes,
    tracer: undefined,
  });

  const agent = new Agent({
    container,
    tools: toolRegistry,
    providers: providerRegistry,
    events,
    pipelines,
    context,
    maxIterations: config.tools?.maxIterations ?? DEFAULT_TOOLS_CONFIG.maxIterations,
    iterationTimeoutMs: config.tools?.iterationTimeoutMs ?? DEFAULT_TOOLS_CONFIG.iterationTimeoutMs,
    executionStrategy:
      config.tools?.defaultExecutionStrategy ?? DEFAULT_TOOLS_CONFIG.defaultExecutionStrategy,
    perIterationOutputCapBytes:
      config.tools?.perIterationOutputCapBytes ?? DEFAULT_TOOLS_CONFIG.perIterationOutputCapBytes,
    confirmAwaiter: undefined,
    toolExecutor,
  });
  console.log('[WebUI] Agent initialized');

  // ── Brain — policy → LLM tiered decision layer ─────────────────────────
  // Same positioning as the CLI: one Brain per process at
  // TOKENS.BrainArbiter. The WebUI has no human-escalation prompt yet, so
  // the chain stops at the LLM tier — `ask_human` decisions surface to the
  // browser as `brain.event` WS messages and the caller's fallback applies.
  const brainSettings: { maxAutoRisk: BrainAutoRisk } = { maxAutoRisk: 'medium' };
  // Lazy wrapper so the LLM tier always sees the LIVE provider/model —
  // both are swapped at runtime via the settings panel.
  const autonomousBrain: BrainArbiter = {
    decide: (request) =>
      createAutonomyBrain({
        provider,
        model: context.model,
        maxAutoRisk: 'all', // the tiered ceiling gates risk — keep inner permissive
      }).decide(request),
  };
  const brain = new ObservableBrainArbiter(
    createTieredBrainArbiter({
      policy: new DefaultBrainArbiter(),
      autonomous: autonomousBrain,
      getMaxAutoRisk: () => brainSettings.maxAutoRisk,
    }),
    events,
  );
  container.bind(TOKENS.BrainArbiter, () => brain);

  // Self-activation: watch for tool-failure streaks / error storms and
  // steer this session's leader via the shared project mailbox. `session`
  // is mutable (swapped on /new and resume) — read it at send time so the
  // steer always targets the LIVE session's leader identity.
  const brainMailbox = new GlobalMailbox(wpaths.projectDir, events);
  const brainMonitor = new BrainMonitor({
    events,
    brain,
    intervene: async ({ subject, body }) => {
      const tag = mailboxSessionTag(session.id);
      await brainMailbox.send({
        from: `brain@${tag}`,
        to: `leader@${tag}`,
        type: 'steer',
        subject,
        body,
        priority: 'high',
      });
    },
  });
  brainMonitor.start();
  console.log('[WebUI] Brain initialized (tiered policy → LLM, monitor active)');

  // Decision log for the /brain command — last 20 decisions, newest last.
  const brainLog: Array<{ at: number; kind: string; question: string; outcome: string }> = [];
  const pushBrainLog = (entry: (typeof brainLog)[number]) => {
    brainLog.push(entry);
    if (brainLog.length > 20) brainLog.shift();
  };
  events.on('brain.decision_answered', (e) =>
    pushBrainLog({
      at: e.at,
      kind: 'answered',
      question: e.request.question,
      outcome: e.decision.type === 'answer' ? (e.decision.optionId ?? e.decision.text) : '',
    }),
  );
  events.on('brain.decision_ask_human', (e) =>
    pushBrainLog({ at: e.at, kind: 'ask_human', question: e.request.question, outcome: 'needs human judgement' }),
  );
  events.on('brain.decision_denied', (e) =>
    pushBrainLog({
      at: e.at,
      kind: 'denied',
      question: e.request.question,
      outcome: e.decision.type === 'deny' ? e.decision.reason : '',
    }),
  );
  events.on('brain.intervention', (e) =>
    pushBrainLog({
      at: e.at,
      kind: 'intervention',
      question: e.request.question,
      outcome: e.intervened ? 'steered the agent' : 'observed (no action)',
    }),
  );

  // AutoPhase handler — manages AutoPhaseRunner lifecycle via WS messages.
  // Stored under the per-project autophase dir (not the shared SDD task-graphs).
  const autoPhaseHandler = new AutoPhaseWebSocketHandler(
    agent,
    context,
    logger,
    wpaths.projectAutophase,
    events,
    projectRoot,
  );

  // Worktree handler — subscribes to the shared EventBus `worktree.*` events
  // and streams live swim-lane / DAG state to connected clients.
  const worktreeHandler = new WorktreeWebSocketHandler(events, logger);

  // Collaboration handler — Phase 1 of idea #13. Lets a second client
  // (e.g. a senior dev) join an active agent run as a read-only
  // observer and watch a live mirror of kernel events. Annotated and
  // controller roles land in Phase 2/3. The session reader enables
  // replay-on-join for late observers.
  const collabHandler = new CollaborationWebSocketHandler(
    events,
    logger,
    sessionReader,
    annotationsStore,
    collabBus,
  );

  // Helper: build the rich session.start payload from current runtime state.
  // Centralised so initial connect, post-/new, and post-model.switch all
  // broadcast the same shape — frontend treats this as the single source of
  // truth for everything in the status bar (model, context window, project).
  async function sessionStartPayload(): Promise<{
    sessionId: string;
    model: string;
    provider: string;
    maxContext: number;
    /** USD per 1M input tokens (0 if unknown / free). */
    inputCost: number;
    /** USD per 1M output tokens. */
    outputCost: number;
    /** USD per 1M cache-read tokens. */
    cacheReadCost: number;
    projectName: string;
    projectRoot: string;
    cwd: string;
    mode: string;
    contextMode: string;
  }> {
    let maxContext = 0;
    let inputCost = 0;
    let outputCost = 0;
    let cacheReadCost = 0;
    try {
      const m = await modelsRegistry.getModel(config.provider, config.model);
      maxContext = m?.capabilities?.maxContext ?? 0;
      // Fall back to the provider's raw model data from the registry when the
      // resolved model has no maxContext (e.g. a user-defined or API-proxied
      // model that wasn't in the models.dev catalog). DefaultModelsRegistry
      // exposes getProvider() which gives us the model's limit.context directly.
      if (!maxContext) {
        try {
          const provider = await (
            modelsRegistry as { getProvider(id: string): Promise<{ models: Array<{ id: string; limit?: { context?: number } }> } | undefined> }
          ).getProvider(config.provider);
          const rawModel = provider?.models.find((mod) => mod.id === config.model);
          maxContext = rawModel?.limit?.context ?? 0;
        } catch {
          /* best-effort — leave maxContext at whatever the registry set it */
        }
      }
      // models.dev pricing is dollars per 1M tokens; some providers omit the
      // field for free/unmetered plans (e.g. minimax-coding-plan) — in that
      // case we report 0 and the cost chip just stays at $0.
      const rates = getCostRates(m);
      inputCost = rates.input;
      outputCost = rates.output;
      cacheReadCost = rates.cacheRead;
    } catch {
      // best-effort
    }
    return {
      sessionId: session.id,
      model: config.model,
      provider: config.provider,
      maxContext,
      inputCost,
      outputCost,
      cacheReadCost,
      projectName: path.basename(projectRoot) || projectRoot,
      projectRoot,
      cwd: workingDir,
      mode: modeId,
      contextMode: String(context.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID),
    };
  }

  // WebSocket server(s).
  //
  // When the user keeps the default loopback bind (127.0.0.1), we ALSO open a
  // second listener on ::1 (IPv6 loopback). Reason: Chrome/Edge on Windows
  // resolve `localhost` to `[::1]` before `127.0.0.1`, so a single v4-only
  // bind causes "ws disconnect hep" — clients hammer the v6 socket, get
  // ECONNREFUSED, fall back to v4 inconsistently. Listening on both v4 and v6
  // loopback keeps the connection scope "this machine only" while removing
  // the resolution-order coin flip.
  //
  // When the user explicitly sets WS_HOST (e.g. 0.0.0.0 or a LAN IP), we
  // respect that choice exactly and don't add a second listener.
  // Generate a random WS auth token so only callers that know the token
  // can connect. Printed to console on startup; the frontend reads it from
  // the URL query param `?token=...`. Without a token, any client on the
  // network can connect and send `user_message`/`key.add`/`model.switch`.
  const wsToken = generateAuthToken();
  // Token is sent to clients via session.start payload — log without any
  // token characters to prevent search-space reduction for brute-force attacks.
  console.log('[WebUI] WS auth token generated (redacted from logs)');

  // CSWSH guard + token auth: when the user exposes the socket beyond loopback,
  // require the shared token; loopback connections bootstrap without one. The
  // policy (DNS-rebinding Host guard, constant-time token compare, loopback
  // bootstrap) lives in ./ws-auth.ts as pure functions — this closure just
  // pulls the relevant fields off the incoming request and delegates.
  const verifyClient = (info: {
    origin: string;
    secure: boolean;
    req: import('node:http').IncomingMessage;
  }) =>
    verifyWsClient({
      origin: info.origin,
      url: info.req.url ?? '',
      hostHeader: info.req.headers.host,
      remoteAddress: info.req.socket.remoteAddress,
      // C-2 fix: accept the token via the HttpOnly cookie set by
      // `/ws-auth` (preferred) OR the URL query param (non-browser
      // fallback). The cookie path closes the C-598 query-string
      // exposure class.
      cookieHeader: info.req.headers.cookie,
      wsHost,
      expectedToken: wsToken,
    });
  // Cap inbound frame size (8 MiB) so a single oversized message can't exhaust
  // memory. Agent messages are small; large pastes/attachments stay well under.
  const WS_MAX_PAYLOAD = 8 * 1024 * 1024;
  const wssPrimary = new WebSocketServer({
    port: wsPort,
    host: wsHost,
    verifyClient,
    maxPayload: WS_MAX_PAYLOAD,
  } as ConstructorParameters<typeof WebSocketServer>[0]);
  const wssSecondary =
    wsHost === '127.0.0.1'
      ? new WebSocketServer({
          port: wsPort,
          host: '::1',
          verifyClient,
          maxPayload: WS_MAX_PAYLOAD,
        } as ConstructorParameters<typeof WebSocketServer>[0])
      : null;
  const clients = new Map<WebSocket, ConnectedClient>();

  // ── Subscribe to working directory changes from the CLI ──────────────
  // When ctx.setWorkingDir() is called from the CLI (e.g. /wd, /cd, or
  // the set_working_dir tool), update the server's workingDir reference
  // and broadcast to all connected WebUI clients so the file explorer
  // and the WorkingDirChip UI stay in sync.
  context.onWorkingDirChanged((newDir) => {
    workingDir = newDir;
    broadcast(clients, {
      type: 'working_dir.changed',
      payload: { cwd: newDir, projectRoot },
    });
  });

  // ── Eternal-autonomy iteration broadcast (PR 4 of Phase 2) ─────────
  // When the CLI passes `opts.subscribeEternalIteration`, hook the
  // returned observer into a WS broadcast so every connected client
  // gets a live stream of `JournalEntry` items as the engine ticks.
  // The disposer is captured and invoked on shutdown() so the CLI's
  // engine subscription is properly torn down with the webui.
  let eternalSubscription: { dispose: () => void } | null = null;
  if (opts.subscribeEternalIteration) {
    eternalSubscription = createEternalSubscription(
      opts.subscribeEternalIteration,
      broadcast,
      () => clients,
    );
  }

  // Per-connection message rate limiting: 60 messages per 60-second window.
  // Exceeding clients are temporarily blocked to prevent flooding.
  // Uses sessionId as the key once connected, falling back to ws for
  // pre-auth messages — prevents connection-reuse bypass.
  // Rate limit OFF by default (counted pings/list calls too and tripped during
  // normal use). Opt in via WEBUI_RATE_LIMIT=<messages-per-60s> for LAN exposure.
  const RATE_LIMIT_MESSAGES = Number.parseInt(process.env['WEBUI_RATE_LIMIT'] ?? '0', 10);
  const RATE_LIMIT_WINDOW_MS = 60_000;
  const rateLimits = new Map<string, { count: number; resetAt: number }>();

  function checkRateLimit(ws: WebSocket, client: ConnectedClient): boolean {
    if (RATE_LIMIT_MESSAGES <= 0) return true; // disabled
    const now = Date.now();
    // Prefer the per-client authenticated sessionId; fall back to the
    // WebSocket identity for pre-auth messages before session.start.
    const key = client.sessionId ?? String(ws);
    const limit = rateLimits.get(key);
    if (!limit || now > limit.resetAt) {
      rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }
    if (limit.count >= RATE_LIMIT_MESSAGES) return false;
    limit.count++;
    return true;
  }

  /** Holds the AbortController for the currently in-flight agent.run().
   *  Non-null while the agent is running; guarded at the user_message
   *  handler to prevent concurrent runs that would corrupt shared state
   *  (context, agent, tokenCounter). A second user_message while running
   *  is answered with an inline error instead of being queued — the
   *  caller should wait for run.result. */
  let runLock: AbortController | null = null;

  console.log(
    `[WebUI] WebSocket server running on ws://${wsHost}:${wsPort}` +
      (wssSecondary ? ` (and ws://[::1]:${wsPort})` : ''),
  );

  // Pending permission confirmations. When the agent emits
  // tool.confirm_needed, we store the resolve function here keyed by
  // toolUseId. When the client sends tool.confirm_result back, we look
  // it up and resolve — unblocking the agent loop.
  const pendingConfirms = new Map<string, (d: 'yes' | 'no' | 'always' | 'deny') => void>();

  const handleConnection = (ws: WebSocket): void => {
    const client: ConnectedClient = { ws, sessionId: session.id, connectedAt: Date.now() };
    clients.set(ws, client);

    // sessionStartPayload handles errors internally; no explicit catch needed.
    // Adding a catch would be defensive but sessionStartPayload already has try-catch.
    void sessionStartPayload()
      .then((payload) => {
        send(ws, { type: 'session.start', payload });
      })
      .catch((err) => {
        // Log at warn level since sessionStartPayload should rarely fail.
        // This prevents silent failures if internal error handling changes.
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'webui.session_start_payload_failed',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }));
      });

    // Register this client with the AutoPhase handler so it receives phase events
    autoPhaseHandler.addClient(ws);
    // …and the worktree handler for live isolation lanes.
    worktreeHandler.addClient(ws);
    // …and the collaboration handler for read-only session observation.
    collabHandler.addClient(ws);

    ws.on('message', async (data) => {
      if (!checkRateLimit(ws, client)) {
        send(ws, {
          type: 'error',
          payload: {
            phase: 'rate_limit',
            message: 'Too many messages. Please wait before sending more.',
          },
        });
        return;
      }
      try {
        // Prototype pollution guard: reject messages whose root-level payload
        // contains __proto__, constructor, or prototype keys. These could
        // cause prototype pollution via Object.assign({}, payload) or
        // spread {...payload}. The top-level check below catches the
        // dangerous keys; nested payload sub-objects are low-risk since
        // handlers don't do deep property merges.
        const rawObj = JSON.parse(data.toString());
        if (typeof rawObj === 'object' && rawObj !== null) {
          const obj = rawObj as Record<string, unknown>;
          if ('__proto__' in obj || 'constructor' in obj || 'prototype' in obj) {
            send(ws, {
              type: 'error',
              payload: { phase: 'parse', message: 'Invalid message object' },
            });
          } else {
            await handleMessage(ws, client, rawObj as WSClientMessage);
          }
        } else {
          // Non-object JSON (array, string, number…) — pass through
          await handleMessage(ws, client, rawObj as unknown as WSClientMessage);
        }
      } catch (err) {
        console.error(JSON.stringify({
          level: 'error',
          event: 'webui.ws_message_parse_failed',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }));
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      rateLimits.delete(String(ws));
      // If the client disconnects while a permission prompt is pending,
      // resolve all pending confirms with 'no' so the agent loop doesn't
      // hang forever waiting for a response that will never come.
      if (pendingConfirms.size > 0) {
        for (const [id, resolve] of pendingConfirms) {
          resolve('no');
          pendingConfirms.delete(id);
        }
      }
    });

    ws.on('error', (err) => {
      // Without this handler an errored socket would crash the process.
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'webui.client_socket_error',
        message: err.message,
        timestamp: new Date().toISOString(),
      }));
    });
  };

  // Audit-level-aware session log bridge — persists tool/error/provider
  // events to the session JSONL with the same contract as the CLI. The
  // getter form resolves the CURRENT writer on every append so events
  // follow session.new / session.resume / projects.select swaps.
  const sessionLogging = resolveSessionLoggingConfig(
    config as unknown as Parameters<typeof resolveSessionLoggingConfig>[0],
  );
  const sessionBridge = createSessionEventBridge(
    () => context.session ?? session,
    sessionLogging.auditLevel,
    { sampling: sessionLogging.sampling },
  );

  let eventsArmed = false;
  const armOnce = (label: string): void => {
    if (eventsArmed) return;
    eventsArmed = true;
    console.log(`[WebUI] Backend ready (${label})`);
    setupEvents({ events, broadcast, clients, config, context, pendingConfirms, globalConfigPath, sessionBridge });
  };

  wssPrimary.on('listening', () => armOnce(`${wsHost}:${wsPort}`));
  wssPrimary.on('connection', handleConnection);
  wssPrimary.on('error', (err) => {
    console.error(JSON.stringify({
      level: 'error',
      event: 'webui.ws_server_error',
      host: wsHost,
      message: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }));
  });

  if (wssSecondary) {
    wssSecondary.on('listening', () => armOnce(`::1:${wsPort}`));
    wssSecondary.on('connection', handleConnection);
    wssSecondary.on('error', (err: NodeJS.ErrnoException) => {
      // Best-effort secondary: if IPv6 loopback isn't available on this host
      // (e.g. disabled in OS), just log and continue. Primary v4 is enough.
      if (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') {
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'webui.ipv6_unavailable',
          code: err.code,
          message: err.message,
          timestamp: new Date().toISOString(),
        }));
      } else {
        console.error(JSON.stringify({
          level: 'error',
          event: 'webui.ws_server_error',
          host: '::1',
          message: err.message,
          timestamp: new Date().toISOString(),
        }));
      }
    });
  }

  // ── Project manifest helpers ──────────────────────────────────────────

  interface ProjectEntry {
    name: string;
    root: string;
    slug: string;
    lastSeen?: string | undefined;
    createdAt?: string | undefined;
    /** Working directory of the most recent session (may differ from root). */
    lastWorkingDir?: string | undefined;
  }

  interface ProjectsManifest {
    projects: ProjectEntry[];
  }

  /**
   * Idempotent manifest registration (mirrors the CLI's
   * touchProjectInManifest): create the projects.json entry when missing,
   * refresh lastSeen/lastWorkingDir when present.
   */
  async function touchProjectEntry(root: string, workDir?: string): Promise<void> {
    const resolved = path.resolve(root);
    const manifest = await loadManifest(globalConfigPath);
    const now = new Date().toISOString();
    const existing = manifest.projects.find((p) => path.resolve(p.root) === resolved);
    if (existing) {
      existing.lastSeen = now;
      if (workDir) existing.lastWorkingDir = path.resolve(workDir);
    } else {
      manifest.projects.push({
        name: path.basename(resolved),
        root: resolved,
        slug: generateProjectSlug(resolved),
        createdAt: now,
        lastSeen: now,
        lastWorkingDir: workDir ? path.resolve(workDir) : undefined,
      });
    }
    await saveManifest(manifest, globalConfigPath);
    await ensureProjectDataDir(generateProjectSlug(resolved), globalConfigPath);
  }

  function projectsJsonPath(globalConfigPath: string): string {
    const base = path.dirname(globalConfigPath);
    return path.join(base, 'projects.json');
  }

  async function loadManifest(globalConfigPath: string): Promise<ProjectsManifest> {
    try {
      const raw = await fs.readFile(projectsJsonPath(globalConfigPath), 'utf8');
      const parsed = JSON.parse(raw) as ProjectsManifest;
      return { projects: parsed.projects ?? [] };
    } catch {
      return { projects: [] };
    }
  }

  async function saveManifest(manifest: ProjectsManifest, globalConfigPath: string): Promise<void> {
    const file = projectsJsonPath(globalConfigPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
  }

  function generateProjectSlug(rootPath: string): string {
    // Canonical derivation — must match wstack-paths/projectSlug exactly or
    // the WebUI and CLI would key the same project under different dirs.
    return projectSlug(rootPath);
  }

  async function ensureProjectDataDir(slug: string, globalConfigPath: string): Promise<string> {
    const base = path.dirname(globalConfigPath);
    const dir = path.join(base, 'projects', slug);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async function handleMessage(
    ws: WebSocket,
    _client: ConnectedClient,
    msg: WSClientMessage,
  ): Promise<void> {
    switch (msg.type) {
      // Collaboration messages short-circuit the user/agent flow.
      // They don't touch runLock, the agent loop, or the message queue —
      // they're pure transport for the live observer mirror.
      case 'collab.join':
      case 'collab.leave':
      case 'collab.annotate':
      case 'collab.resolve': {
        collabHandler.handleMessage(ws, msg as { type: string; payload?: unknown | undefined });
        return;
      }
      case 'user_message': {
        const content = (msg as { payload: { content: string } }).payload.content;

        // Guard against concurrent agent runs — a second user_message while
        // the agent is already processing would kick off two agent.run()
        // calls on the same shared context/agent, leading to corrupted
        // state (duplicate tool bubbles, mixed text_delta streams, token
        // counter undercount). Reject with an inline error; the frontend
        // should wait for run.result before sending the next message.
        if (runLock) {
          send(ws, {
            type: 'error',
            payload: {
              phase: 'user_message',
              message: 'Agent is already processing a request. Wait for the current run to finish.',
            },
          });
          break;
        }

        runLock = new AbortController();
        // Capture so the finally block only clears its own lock — a
        // second race could set a new runLock between await and finally.
        const thisRun = runLock;

        try {
          // Read maxIterations from context.meta so the webui settings
          // panel can adjust the cap dynamically without restarting.
          const maxIt = typeof context.meta['maxIterations'] === 'number'
            ? context.meta['maxIterations']
            : undefined;
          const result = await agent.run(content, { signal: thisRun.signal, maxIterations: maxIt });
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
              message: errMessage(err),
            },
          });
        } finally {
          // Only clear runLock if it's still ours — otherwise we'd wipe a
          // newer run's controller set after we returned.
          if (runLock === thisRun) {
            runLock = null;
          }
        }
        break;
      }

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

      case 'abort':
        runLock?.abort();
        broadcast(clients, { type: 'error', payload: { phase: 'abort', message: 'User aborted' } });
        break;

      case 'ping':
        send(ws, { type: 'pong', payload: {} });
        break;

      case 'session.new': {
        // Truly fresh chat: new on-disk session AND reset every piece of
        // in-memory state that survived (messages history, todos, read-file
        // tracking, token totals). Otherwise the model still sees the prior
        // turns even though the UI looks empty — that's the "ghost context"
        // bug. After this, the next user message goes out as turn 1 with no
        // prior history.
        //
        // Finalize the writer we are leaving (session_end + close) — same
        // pattern as projects.select/shutdown. Without it the old JSONL
        // never ends cleanly, the summary sidecar/index entry are never
        // written, and the file handle leaks for the daemon's lifetime.
        try {
          await session.append({
            type: 'session_end',
            ts: new Date().toISOString(),
            usage: tokenCounter.total(),
          });
          await session.close();
        } catch {
          // best-effort
        }
        session = await sessionStore.create({
          id: '',
          title: '',
          model: config.model,
          provider: config.provider,
        });
        context.session = session;
        context.state.replaceMessages([]);
        context.state.replaceTodos([]);
        context.readFiles.clear();
        context.fileMtimes.clear();
        tokenCounter.reset();
        sessionStartedAt = Date.now();
        broadcast(clients, { type: 'session.start', payload: await sessionStartPayload() });
        break;
      }

      case 'context.clear': {
        // Same in-memory wipe as session.new, but reuses the current session
        // file (so the JSONL still has the history for audit / replay). The
        // user wants a clean slate on the model side; the disk record stays.
        context.state.replaceMessages([]);
        context.state.replaceTodos([]);
        context.readFiles.clear();
        context.fileMtimes.clear();
        tokenCounter.reset();
        sendResult(ws, true, 'Context cleared');
        broadcast(clients, {
          type: 'session.start',
          payload: { ...(await sessionStartPayload()), reset: true },
        });
        break;
      }

      case 'context.debug': {
        // Per-section token estimate so users can see what's actually eating
        // the context window. The breakdown maths lives in ./token-estimator.ts
        // (4-chars-per-token heuristic); we layer the active mode/policy on top.
        const breakdown = estimateContextBreakdown({
          systemPrompt: context.systemPrompt,
          tools: toolRegistry.list(),
          messages: context.messages,
        });
        send(ws, {
          type: 'context.debug',
          payload: {
            ...breakdown,
            mode: context.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID,
            policy: context.meta['contextWindowPolicy'],
          },
        });
        break;
      }

      case 'context.compact': {
        const aggressive = !!(msg as { payload?: { aggressive?: boolean | undefined } }).payload
          ?.aggressive;
        try {
          const report = await compactor.compact(context, { aggressive });
          send(ws, {
            type: 'context.compacted',
            payload: {
              before: report.before,
              after: report.after,
              saved: Math.max(0, report.before - report.after),
              reductions: report.reductions,
              repaired: report.repaired,
            },
          });
          sendResult(
            ws,
            true,
            `Compacted: ${report.before} → ${report.after} tokens (saved ~${Math.max(0, report.before - report.after)})`,
          );
        } catch (err) {
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      case 'context.repair': {
        const beforeMessages = context.messages.length;
        const repaired = repairToolUseAdjacency(context.messages);
        if (repaired.report.changed) {
          context.state.replaceMessages(repaired.messages);
        }
        const payload = {
          removedToolUses: repaired.report.removedToolUses,
          removedToolResults: repaired.report.removedToolResults,
          removedMessages: repaired.report.removedMessages,
          beforeMessages,
          afterMessages: context.messages.length,
        };
        broadcast(clients, { type: 'context.repaired', payload });
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
        const active = String(context.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID);
        const allModes = customModeStore.list().map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          isActive: m.id === active,
          thresholds: m.thresholds,
          preserveK: m.preserveK,
          eliseThreshold: m.eliseThreshold,
          custom: (m as { custom?: boolean }).custom === true,
        }));
        send(ws, {
          type: 'context.modes.list',
          payload: { activeId: active, modes: allModes },
        });
        break;
      }

      case 'context.mode.switch': {
        const { id } = (msg as { payload: { id: string } }).payload;
        // Try built-in first, then custom
        let policy = resolveContextWindowPolicy({}, id);
        if (policy.id !== id) {
          // Check custom modes
          const customModes = customModeStore.list().filter(
            (m) => (m as { custom?: boolean }).custom === true,
          );
          const custom = customModes.find((m) => m.id === id);
          if (!custom) {
            sendResult(ws, false, `Unknown context mode "${id}"`);
            break;
          }
          // Create a policy from the custom mode
          policy = custom as unknown as typeof policy;
        }
        context.meta['contextWindowMode'] = policy.id;
        context.meta['contextWindowPolicy'] = policy;
        sendResult(ws, true, `Context mode switched to ${policy.id}`);
        broadcast(clients, {
          type: 'context.mode.changed',
          payload: { id: policy.id, name: policy.name, policy },
        });
        break;
      }

      case 'context.mode.create': {
        const payload = (msg as { payload: { id: string; name: string; description: string; thresholds: { warn: number; soft: number; hard: number }; preserveK: number; eliseThreshold: number } }).payload;
        const result = customModeStore.create({
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
        sendResult(ws, result.ok, result.error ?? `Mode "${payload.id}" created`);
        break;
      }

      case 'context.mode.update': {
        const payload = (msg as { payload: { id: string; name?: string | undefined; description?: string | undefined; thresholds?: { warn?: number | undefined; soft?: number | undefined; hard?: number | undefined } | undefined; preserveK?: number | undefined; eliseThreshold?: number | undefined } }).payload;
        const result = customModeStore.update(payload.id, {
          name: payload.name,
          description: payload.description,
          thresholds: payload.thresholds ? {
            warn: payload.thresholds.warn ?? 0.6,
            soft: payload.thresholds.soft ?? 0.75,
            hard: payload.thresholds.hard ?? 0.9,
          } : undefined,
          preserveK: payload.preserveK,
          eliseThreshold: payload.eliseThreshold,
        });
        sendResult(ws, result.ok, result.error ?? `Mode "${payload.id}" updated`);
        break;
      }

      case 'context.mode.delete': {
        const { id } = (msg as { payload: { id: string } }).payload;
        // If the active mode is being deleted, reset to default
        if (String(context.meta['contextWindowMode'] ?? '') === id) {
          context.meta['contextWindowMode'] = DEFAULT_CONTEXT_WINDOW_MODE_ID;
          context.meta['contextWindowPolicy'] = resolveContextWindowPolicy({}, DEFAULT_CONTEXT_WINDOW_MODE_ID);
        }
        const result = customModeStore.remove(id);
        sendResult(ws, result.ok, result.error ?? `Mode "${id}" deleted`);
        break;
      }

      case 'providers.list': {
        const providers = await modelsRegistry.listProviders();
        // "Configured" should mean *any* working credential, not just env vars.
        // Users register keys with `wstack auth`, which writes apiKey/apiKeys
        // into config.providers[<id>] — those are decrypted in memory here.
        const savedIds = new Set(Object.keys(config.providers ?? {}));
        send(ws, {
          type: 'provider.catalog',
          payload: {
            providers: providers.map((p) => ({
              id: p.id,
              name: p.name,
              family: p.family,
              apiBase: p.apiBase,
              envVars: p.envVars,
              modelCount: p.models.length,
              hasApiKey: savedIds.has(p.id) || p.envVars.some((v) => !!process.env[v]),
            })),
          },
        });
        break;
      }

      case 'providers.saved': {
        const saved = await providerHandlers.loadConfigProviders();
        send(ws, {
          type: 'providers.saved',
          payload: {
            providers: Object.entries(saved).map(([id, cfg]) => {
              const keys = normalizeKeys(cfg);
              return {
                id,
                family: cfg.family ?? id,
                baseUrl: cfg.baseUrl,
                apiKeys: keys.map((k) => ({
                  label: k.label,
                  maskedKey: maskedKey(k.apiKey),
                  isActive: k.label === cfg.activeKey,
                  createdAt: k.createdAt,
                })),
              };
            }),
          },
        });
        break;
      }

      case 'provider.models': {
        const providerId = (msg as { payload: { providerId: string } }).payload.providerId;
        const provider = await modelsRegistry.getProvider(providerId);
        if (provider) {
          send(ws, {
            type: 'provider.models',
            payload: {
              provider: providerId,
              models: provider.models.map((m) => ({
                id: m.id,
                name: m.name,
                releaseDate: (m as { release_date?: string | undefined }).release_date,
                contextWindow: (m as { limit?: { context?: number | undefined } }).limit?.context,
                inputCost: (m as { cost?: { input?: number | undefined } }).cost?.input,
                outputCost: (m as { cost?: { output?: number | undefined } }).cost?.output,
                capabilities: [
                  ...((m as { tool_call?: boolean | undefined }).tool_call ? ['tools'] : []),
                  ...((m as { reasoning?: boolean | undefined }).reasoning ? ['reasoning'] : []),
                ],
              })),
            },
          });
        }
        break;
      }

      case 'model.switch': {
        const { provider: newProvider, model: newModel } = (
          msg as { payload: { provider: string; model: string } }
        ).payload;
        try {
          // Update config
          config = patchConfig(config, { provider: newProvider, model: newModel });
          configStore.update({ provider: newProvider, model: newModel });
          context.model = newModel;

          // Create new provider instance — fail loudly if the user picks a
          // provider with no creds rather than silently keeping the old one.
          const providerCfg = config.providers?.[newProvider] ?? { type: newProvider };
          const newProv = providerRegistry.has(newProvider)
            ? providerRegistry.create({ ...providerCfg, type: newProvider })
            : makeProviderFromConfig(newProvider, providerCfg);
          context.provider = newProv;

          // Update AutoCompactionMiddleware with the new model's maxContext so
          // backend threshold triggers (warn/soft/hard) use the correct denominator.
          // sessionStartPayload is called below (after this block) and uses
          // the new provider for its modelsRegistry lookup.
          updateAutoCompactionMaxContext?.(newProv);

          // Persist to global config file
          try {
            configWriteLock = configWriteLock.then(async () => {
              const raw = await fs.readFile(globalConfigPath, 'utf8');
              const parsed = JSON.parse(raw);
              parsed.provider = newProvider;
              parsed.model = newModel;
              await atomicWrite(globalConfigPath, JSON.stringify(parsed, null, 2));
            });
            await configWriteLock;
          } catch (err) {
            console.warn(JSON.stringify({
              level: 'warn',
              event: 'webui.config_save_failed',
              message: err instanceof Error ? err.message : String(err),
              timestamp: new Date().toISOString(),
            }));
          }

          // Toast for the SettingsPanel
          send(ws, {
            type: 'key.operation_result',
            payload: { success: true, message: `Switched to ${newProvider} / ${newModel}` },
          });
        } catch (err) {
          send(ws, {
            type: 'key.operation_result',
            payload: {
              success: false,
              message: `Switch failed: ${errMessage(err)}`,
            },
          });
          break;
        }

        broadcast(clients, { type: 'session.start', payload: await sessionStartPayload() });
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
          const history = recentTextTurns(context.messages);
          const result = await enhanceUserPrompt({
            provider: context.provider,
            model: context.model,
            text,
            history,
            timeoutMs: 90000,
            onError: (reason) => {
              console.warn(JSON.stringify({
                level: 'warn',
                event: 'model.refine_failed',
                reason,
                timestamp: new Date().toISOString(),
              }));
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
          console.error(JSON.stringify({
            level: 'error',
            event: 'model.refine.error',
            error: errMessage(err),
            timestamp: new Date().toISOString(),
          }));
          send(ws, {
            type: 'model.refine_result',
            payload: { refined: text, english: text, error: errMessage(err) },
          });
        }
        break;
      }

      case 'key.add':
      case 'key.update': {
        const { providerId, label, apiKey } = (
          msg as { payload: { providerId: string; label: string; apiKey: string } }
        ).payload;
        await providerHandlers.handleKeyUpsert(ws, providerId, label, apiKey);
        break;
      }

      case 'key.delete': {
        const { providerId, label } = (msg as { payload: { providerId: string; label: string } })
          .payload;
        await providerHandlers.handleKeyDelete(ws, providerId, label);
        break;
      }

      case 'key.set_active': {
        const { providerId, label } = (msg as { payload: { providerId: string; label: string } })
          .payload;
        await providerHandlers.handleKeySetActive(ws, providerId, label);
        break;
      }

      case 'provider.add': {
        const p = (
          msg as {
            payload: {
              id: string;
              family: string;
              baseUrl?: string | undefined;
              apiKey?: string | undefined;
            };
          }
        ).payload;
        await providerHandlers.handleProviderAdd(ws, p);
        break;
      }

      case 'provider.remove': {
        const { providerId } = (msg as { payload: { providerId: string } }).payload;
        await providerHandlers.handleProviderRemove(ws, providerId);
        break;
      }

      case 'sessions.list': {
        // Per-project history. Sessions live under .wrongstack/sessions/ for
        // this project; we never enumerate cross-project state.
        const limit = (msg as { payload?: { limit?: number | undefined } }).payload?.limit ?? 50;
        try {
          const list = await sessionStore.list(limit);
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
                isCurrent: s.id === session.id,
              })),
            },
          });
        } catch (err) {
          send(ws, {
            type: 'sessions.list',
            payload: { sessions: [], error: errMessage(err) },
          });
        }
        break;
      }

      case 'session.delete': {
        const { id } = (msg as { payload: { id: string } }).payload;
        try {
          if (id === session.id) {
            sendResult(ws, false, 'Cannot delete the active session');
            break;
          }
          await sessionStore.delete(id);
          sendResult(ws, true, `Session ${id} deleted`);
        } catch (err) {
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      case 'session.resume': {
        // Load a past session's messages + usage, swap the active session
        // writer, hydrate the live Context, then broadcast a session.start
        // payload tagged with the replayed transcript so the UI can render
        // the chat history.
        const { id } = (msg as { payload: { id: string } }).payload;
        try {
          if (id === session.id) {
            sendResult(ws, false, 'Session is already active');
            break;
          }
          const resumed = await sessionStore.resume(id);
          // Finalize the prior writer (session_end + close) best-effort;
          // swallow errors so we don't block the resume on a crashed file
          // handle. The end marker is what makes the session we are leaving
          // read as cleanly completed (summary outcome, endedAt).
          try {
            await session.append({
              type: 'session_end',
              ts: new Date().toISOString(),
              usage: tokenCounter.total(),
            });
            await session.close();
          } catch {
            /* noop */
          }
          session = resumed.writer;
          context.session = session;
          context.state.replaceMessages(resumed.data.messages);
          context.readFiles.clear();
          context.fileMtimes.clear();
          tokenCounter.reset();
          // Replay usage so the topbar shows accurate totals after resume.
          tokenCounter.account(resumed.data.usage, config.model);
          sessionStartedAt = Date.now();
          broadcast(clients, {
            type: 'session.start',
            payload: {
              ...(await sessionStartPayload()),
              reset: true,
              replayMessages: resumed.data.messages,
              replayUsage: resumed.data.usage,
            },
          });
          sendResult(ws, true, `Resumed session ${id}`);
        } catch (err) {
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      case 'session.save': {
        // SessionWriter already flushes after every event; this is mostly a
        // no-op marker so the user gets confirmation. Useful for habit
        // parity with the CLI /save command.
        sendResult(ws, true, `Session ${session.id} is auto-saved`);
        break;
      }

      case 'tools.list': {
        // Full tool registry dump for the /tools inspect view. We surface
        // name, description, and schema-derived param names so the user
        // can tell at a glance which tools the model can call right now.
        const list = toolRegistry.list().map((t) => {
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

      // ── Memory operations — delegated to shared handlers (memory-handlers.ts) ──
      case 'memory.list':
        return handleMemoryList(ws, memoryStore);
      case 'memory.remember':
        return handleMemoryRemember(ws, msg, memoryStore);
      case 'memory.forget':
        return handleMemoryForget(ws, msg, memoryStore);

      case 'skills.list': {
        if (!skillLoader) {
          send(ws, { type: 'skills.list', payload: { skills: [], enabled: false } });
          break;
        }
        try {
          const manifests = await skillLoader.list();
          const entries = await skillLoader.listEntries();
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
              error: errMessage(err),
            },
          });
        }
        break;
      }

      case 'diag.get': {
        // Snapshot of the moving parts so the user can debug "why is X
        // not working?" without diving into the server logs.
        const usage = tokenCounter.total();
        send(ws, {
          type: 'diag.get',
          payload: {
            provider: config.provider,
            model: config.model,
            cwd: projectRoot,
            sessionId: session.id,
            tools: {
              count: toolRegistry.list().length,
              names: toolRegistry.list().map((t) => t.name),
            },
            features: {
              memory: !!config.features?.memory,
              skills: !!config.features?.skills,
              modelsRegistry: !!config.features?.modelsRegistry,
            },
            mode: modeId ?? 'default',
            usage,
            messages: context.messages.length,
            todos: context.todos.length,
          },
        });
        break;
      }

      case 'todos.get': {
        // On-demand snapshot — used when a UI surface first mounts and
        // needs to render the live todo list without waiting for the next
        // tool.executed to broadcast.
        send(ws, {
          type: 'todos.updated',
          payload: { todos: [...context.todos] },
        });
        break;
      }

      case 'todos.clear': {
        // Manual override — the agent normally curates this list via
        // TodoWrite, but the user might want a clean slate without losing
        // the rest of the context. Use state.replaceTodos so observers
        // (checkpoint writer) stay in sync.
        context.state.replaceTodos([]);
        sendResult(ws, true, 'Todos cleared');
        broadcast(clients, { type: 'todos.updated', payload: { todos: [] } });
        break;
      }

      case 'todos.remove': {
        // Remove a single todo item by id or 1-based index.
        const payload = msg.payload as
          | { id?: string | undefined; index?: number | undefined }
          | undefined;
        if (!payload) {
          sendResult(ws, false, 'Missing id or index');
          break;
        }
        const { id, index } = payload;
        let targetIdx = -1;
        if (typeof id === 'string') {
          targetIdx = context.todos.findIndex((t) => t.id === id);
        } else if (typeof index === 'number' && index > 0) {
          targetIdx = index - 1;
        }
        if (targetIdx < 0 || !context.todos[targetIdx]) {
          sendResult(ws, false, 'Todo not found');
          break;
        }
        const removed = expectDefined(context.todos[targetIdx]);
        const next = [...context.todos.slice(0, targetIdx), ...context.todos.slice(targetIdx + 1)];
        context.state.replaceTodos(next);
        sendResult(ws, true, `Removed: ${removed.content}`);
        broadcast(clients, { type: 'todos.updated', payload: { todos: next } });
        break;
      }

      case 'tasks.get': {
        // On-demand task snapshot — loads from <sessionId>.tasks.json
        const taskPath = (context.meta as Record<string, unknown>)['task.path'];
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
          send(ws, { type: 'tasks.updated', payload: { tasks: [], error: 'Task storage not configured.' } });
        }
        break;
      }

      case 'plan.get': {
        // On-demand plan snapshot — used when a UI surface first mounts
        // and needs to render the live plan without waiting for the next
        // tool.executed to broadcast.
        const planPath = (context.meta as Record<string, unknown>)['plan.path'];
        if (typeof planPath === 'string' && planPath) {
          try {
            const { loadPlan } = await import('@wrongstack/core');
            const plan = await loadPlan(planPath);
            send(ws, {
              type: 'plan.updated',
              payload: {
                plan: plan ?? {
                  version: 1,
                  sessionId: session.id,
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
                  sessionId: session.id,
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
        const planPath = (context.meta as Record<string, unknown>)['plan.path'];
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
          let plan = (await loadPlan(planPath)) ?? emptyPlan(session.id);
          for (const item of tpl.items) {
            ({ plan } = addPlanItem(plan, item.title, item.details));
          }
          await savePlan(planPath, plan);
          sendResult(ws, true, `Applied template "${tpl.name}" — ${tpl.items.length} items added.`);
          broadcast(clients, {
            type: 'plan.updated',
            payload: { plan },
          });
        } catch (err) {
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      // ── File operations — delegated to shared handlers (file-handlers.ts) ──
      // These handlers are also used by the CLI's webui-server.ts. When
      // adding or modifying file-operation WebSocket messages, update
      // file-handlers.ts — NOT these case blocks individually.
      case 'files.list':
        return handleFilesList(ws, msg, projectRoot);
      case 'files.tree':
        return handleFilesTree(ws, msg, projectRoot);
      case 'files.read':
        return handleFilesRead(ws, msg, projectRoot);
      case 'files.write':
        return handleFilesWrite(ws, msg, projectRoot);

      case 'modes.list': {
        try {
          const modes = await modeStore.listModes();
          const active = await modeStore.getActiveMode();
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
              error: errMessage(err),
            },
          });
        }
        break;
      }

      case 'mode.switch': {
        const { id } = (msg as { payload: { id: string } }).payload;
        try {
          // 'default' is the implicit no-mode state — persisting null
          // clears the override. Anything else has to exist in the store.
          if (id === 'default') {
            await modeStore.setActiveMode(null);
          } else {
            const found = await modeStore.getMode(id);
            if (!found) throw new Error(`Unknown mode "${id}"`);
            await modeStore.setActiveMode(id);
          }
          modeId = id;
          // Rebuild the system prompt so the next turn picks up the new
          // mode's instructions. The builder caches the environment block
          // per projectRoot (including the modeId), so we clear the cache
          // and rebuild. The `buildMode()` method reads this.opts.modePrompt
          // which is set on the builder constructor — we construct a fresh
          // builder with the updated mode. This is cheap (no fs/net IO in
          // the constructor; the real work happens in build()).
          const modePrompt = id === 'default' ? '' : ((await modeStore.getMode(id))?.prompt ?? '');
          const freshBuilder = new DefaultSystemPromptBuilder({
            memoryStore,
            skillLoader,
            modeStore,
            modeId: id,
            modePrompt,
            modelCapabilities,
          });
          context.systemPrompt = await freshBuilder.build({
            cwd: projectRoot,
            projectRoot,
            tools: toolRegistry.list(),
            provider: config.provider,
            model: config.model,
          });
          sendResult(ws, true, `Switched to mode "${id}"`);
          broadcast(clients, {
            type: 'session.start',
            payload: { ...(await sessionStartPayload()) },
          });
        } catch (err) {
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      case 'stats.get': {
        // Mirror of the CLI's /stats: detailed session report.
        const usage = tokenCounter.total();
        const cacheStats = tokenCounter.cacheStats();
        const m = await modelsRegistry.getModel(config.provider, config.model).catch(() => null);
        const cost = computeUsageCost(usage, getCostRates(m));
        send(ws, {
          type: 'stats.get',
          payload: {
            sessionId: session.id,
            provider: config.provider,
            model: config.model,
            usage,
            cache: cacheStats,
            cost,
            messages: context.messages.length,
            readFiles: context.readFiles.size,
            tools: toolRegistry.list().length,
            elapsedMs: Date.now() - sessionStartedAt,
          },
        });
        break;
      }

      case 'process.list': {
        // Return tracked process list from the process registry.
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
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      case 'process.killAll': {
        try {
          const { getProcessRegistry } = await import('@wrongstack/tools');
          getProcessRegistry().killAll();
          sendResult(ws, true, 'All processes killed');
        } catch (err) {
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      case 'goal.get': {
        // Read goal.json from disk and broadcast to all clients so every
        // connected browser sees the same goal state. The file is polled
        // by the frontend every 10s — we serve the latest snapshot here.
        try {
          const goalPath = path.join(projectRoot, '.wrongstack', 'goal.json');
          const raw = await fs.readFile(goalPath, 'utf8');
          const goal = JSON.parse(raw);
          broadcast(clients, { type: 'goal.updated', payload: goal });
        } catch {
          // No goal file yet or parse error — broadcast null so the
          // frontend clears any stale goal state.
          broadcast(clients, { type: 'goal.updated', payload: null });
        }
        break;
      }

      case 'autonomy.switch': {
        // Autonomy mode switch — forwarded to the agent context.
        // The mode is stored in context.meta for the permission policy to read.
        const { mode } = (msg as { payload: { mode: string } }).payload;
        context.meta['autonomy'] = mode;
        sendResult(ws, true, `Autonomy mode set to "${mode}"`);
        // Keep every browser tab + the settings panel in sync, and persist
        // the durable modes (eternal/eternal-parallel are session-level).
        broadcast(clients, { type: 'prefs.updated', payload: { autonomy: mode } });
        void persistPrefsToConfig({ autonomy: mode });
        break;
      }

      case 'prefs.update': {
        // Batch preference update from the webui. Merges arbitrary key/value
        // pairs into context.meta so the runtime can read them immediately,
        // broadcasts the full pref snapshot to every connected client so all
        // browser tabs stay in sync, and persists the durable keys to
        // config.json (same keys the TUI settings picker writes).
        const payload = (msg as { payload: Record<string, unknown> }).payload;
        // Write each pref into context.meta
        for (const [key, val] of Object.entries(payload)) {
          context.meta[key] = val;
        }
        void persistPrefsToConfig(payload);
        // YOLO mode: toggle the permission policy so tool confirmations
        // are auto-approved instead of prompting the user. Uses the live
        // reference resolved from the container at startup.
        if (typeof payload['yolo'] === 'boolean') {
          permissionPolicy.setYolo?.(payload['yolo']);
        }
        // Also update config.features for feature flags that affect tool/skill
        // initialisation (these were read at startup but can be changed at runtime
        // by the agent's permission middleware or tool guards).
        if (typeof payload['featureMcp'] === 'boolean')
          config.features.mcp = payload['featureMcp'];
        if (typeof payload['featurePlugins'] === 'boolean')
          config.features.plugins = payload['featurePlugins'];
        if (typeof payload['featureMemory'] === 'boolean')
          config.features.memory = payload['featureMemory'];
        if (typeof payload['featureSkills'] === 'boolean')
          config.features.skills = payload['featureSkills'];
        if (typeof payload['featureModelsRegistry'] === 'boolean')
          config.features.modelsRegistry = payload['featureModelsRegistry'];

        // Runtime effects: apply prefs that change server behaviour immediately.

        // contextAutoCompact — toggle AutoCompactionMiddleware in/out of the
        // contextWindow pipeline. When off, the pipeline skips the compaction
        // step entirely (zero overhead). When on, re-adds the middleware.
        if (typeof payload['contextAutoCompact'] === 'boolean') {
          if (payload['contextAutoCompact'] && autoCompactor) {
            // Re-add: remove first (idempotent via optional), then insert.
            pipelines.contextWindow.remove('AutoCompaction', { optional: true });
            pipelines.contextWindow.use({ name: 'AutoCompaction', handler: autoCompactor.handler() });
          } else {
            pipelines.contextWindow.remove('AutoCompaction', { optional: true });
          }
        }

        // logLevel — the DefaultLogger.level property is a public mutable
        // field. Setting it at runtime changes the log threshold immediately
        // (the log() method checks LEVEL_RANK on every call).
        if (typeof payload['logLevel'] === 'string') {
          const valid = ['debug', 'info', 'warn', 'error'] as const;
          if ((valid as readonly string[]).includes(payload['logLevel'])) {
            logger.level = payload['logLevel'] as typeof valid[number];
          }
        }

        // auditLevel — stored in context.meta by the generic loop above.
        // Consumed by the session audit log system at session-close time.

        // Broadcast the full current prefs snapshot to ALL clients.
        broadcast(clients, { type: 'prefs.updated', payload: prefSnapshot() });
        break;
      }

      case 'prefs.get': {
        // Return the current pref snapshot so a freshly-connected client
        // can seed its local-prefs store from the server's truth.
        send(ws, { type: 'prefs.updated', payload: prefSnapshot() });
        break;
      }

      case 'session.checkpoints': {
        // Return session checkpoints for the rewind timeline.
        try {
          const { DefaultSessionRewinder } = await import('@wrongstack/core');
          const rewinder = new DefaultSessionRewinder(
            path.join(projectRoot, '.wrongstack', 'sessions'),
            projectRoot,
          );
          const checkpoints = await rewinder.listCheckpoints(session.id);
          send(ws, {
            type: 'session.checkpoints',
            payload: { checkpoints },
          });
        } catch (err) {
          send(ws, {
            type: 'session.checkpoints',
            payload: { checkpoints: [] },
          });
        }
        break;
      }

      case 'session.rewind': {
        const { checkpointIndex } = (msg as { payload: { checkpointIndex: number } }).payload;
        try {
          const { DefaultSessionRewinder } = await import('@wrongstack/core');
          const rewinder = new DefaultSessionRewinder(
            path.join(projectRoot, '.wrongstack', 'sessions'),
            projectRoot,
          );
          await rewinder.rewindToCheckpoint(session.id, checkpointIndex);
          await context.session.truncateToCheckpoint(checkpointIndex);
          sendResult(ws, true, `Rewound to checkpoint ${checkpointIndex}`);
          broadcast(clients, {
            type: 'session.start',
            payload: { ...(await sessionStartPayload()), reset: true },
          });
        } catch (err) {
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      // ── Project management ────────────────────────────────────────────

      case 'projects.list': {
        try {
          const manifest = await loadManifest(globalConfigPath);
          send(ws, {
            type: 'projects.list',
            payload: { projects: manifest.projects },
          });
        } catch (err) {
          send(ws, {
            type: 'projects.list',
            payload: { projects: [], error: errMessage(err) },
          });
        }
        break;
      }

      case 'projects.add': {
        const { root: addRoot, name: displayName } = (
          msg as { payload: { root: string; name?: string | undefined } }
        ).payload;
        try {
          const resolved = path.resolve(addRoot);
          await fs.access(resolved);
          const stat = await fs.stat(resolved);
          if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);

          const manifest = await loadManifest(globalConfigPath);
          const existing = manifest.projects.find((p) => p.root === resolved);
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

          const name = displayName?.trim() || path.basename(resolved);
          const slug = generateProjectSlug(resolved);
          await ensureProjectDataDir(slug, globalConfigPath);
          const now = new Date().toISOString();
          manifest.projects.push({ name, root: resolved, slug, lastSeen: now, createdAt: now });
          await saveManifest(manifest, globalConfigPath);

          send(ws, {
            type: 'projects.added',
            payload: {
              name,
              root: resolved,
              slug,
              message: `Registered project "${name}"`,
            },
          });
        } catch (err) {
          send(ws, {
            type: 'projects.added',
            payload: {
              name: path.basename(addRoot),
              root: addRoot,
              slug: '',
              message: errMessage(err),
            },
          });
        }
        break;
      }

      case 'projects.select': {
        const { root: selRoot, name: selName } = (
          msg as { payload: { root: string; name?: string | undefined } }
        ).payload;
        try {
          const resolved = path.resolve(selRoot);

          // Validate the directory exists
          try {
            await fs.access(resolved);
            const stat = await fs.stat(resolved);
            if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
          } catch (err) {
            send(ws, {
              type: 'projects.selected',
              payload: {
                root: selRoot,
                name: selName || path.basename(selRoot),
                message: `Cannot switch: ${errMessage(err)}`,
              },
            });
            break;
          }

          // Update lastSeen in manifest
          const manifest = await loadManifest(globalConfigPath);
          const entry = manifest.projects.find((p) => p.root === resolved);
          if (entry) {
            entry.lastSeen = new Date().toISOString();
            entry.lastWorkingDir = resolved;
          } else {
            // Auto-register if not in manifest
            const name = selName?.trim() || path.basename(resolved);
            const slug = generateProjectSlug(resolved);
            manifest.projects.push({
              name,
              root: resolved,
              slug,
              lastSeen: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              lastWorkingDir: resolved,
            });
            await ensureProjectDataDir(slug, globalConfigPath);
          }
          await saveManifest(manifest, globalConfigPath);

          // ── Hot-swap the project root + working dir ─────────────────
          // Abort any in-flight agent run before switching — the agent's
          // context (cwd, projectRoot, session) is about to change and
          // continuing would cause inconsistent state.
          if (runLock) {
            runLock.abort();
            runLock = null;
          }

          projectRoot = resolved;
          workingDir = resolved;

          // Update the live context so tools use the new directory
          context.cwd = workingDir;
          context.projectRoot = projectRoot;

          const switchSlug = entry?.slug ?? generateProjectSlug(resolved);

          // Rebuild the system prompt for the NEW project. The environment
          // block (project root, git status, detected languages) is baked into
          // the prompt at boot and cached by projectRoot; without this rebuild
          // the agent keeps the launch-directory environment and tries to work
          // in the old folder until tool errors force a correction. Mirrors the
          // mode.switch rebuild; best-effort so a failure here leaves the prior
          // (stale-but-usable) prompt rather than breaking the switch.
          try {
            const switchMode =
              modeId === 'default' ? undefined : await modeStore.getMode(modeId);
            const switchBuilder = new DefaultSystemPromptBuilder({
              memoryStore,
              skillLoader,
              modeStore,
              modeId,
              modePrompt: switchMode?.prompt ?? '',
              modelCapabilities,
            });
            context.systemPrompt = await switchBuilder.build({
              cwd: workingDir,
              projectRoot,
              tools: toolRegistry.list(),
              provider: config.provider,
              model: config.model,
            });
          } catch {
            /* best-effort — keep the prior system prompt if rebuild fails */
          }

          // Create a new session store for the new project's sessions dir
          const newSessionsDir = path.join(
            path.dirname(globalConfigPath),
            'projects',
            switchSlug,
            'sessions',
          );
          await fs.mkdir(newSessionsDir, { recursive: true });
          const newSessionStore = new DefaultSessionStore({ dir: newSessionsDir });

          // Switch the session store for the new project.
          // Close the old session gracefully
          const oldSessionId = session.id;
          try {
            await session.append({
              type: 'session_end',
              ts: new Date().toISOString(),
              usage: tokenCounter.total(),
            });
            await session.close();
          } catch {
            // best-effort
          }

          // Create a fresh session in the new project
          sessionStore = newSessionStore;
          session = await sessionStore.create({
            id: '',
            title: '',
            model: config.model,
            provider: config.provider,
          });
          context.session = session;
          context.state.replaceMessages([]);
          context.state.replaceTodos([]);
          context.readFiles.clear();
          context.fileMtimes.clear();
          tokenCounter.reset();
          sessionStartedAt = Date.now();

          // Re-point the cross-process SessionRegistry at the new project +
          // session id. Without this, `/sessions status`, the WebUI sessions
          // dashboard, and the 5s status poll keep listing this process under
          // the launch project's root/workingDir — the WebUI looks like it is
          // still "in" the old folder after the switch. register() is now
          // re-entrant (drops the old entry, restarts a single heartbeat).
          try {
            const registry = getSessionRegistry(wpaths.globalRoot);
            await registry.register({
              sessionId: session.id,
              projectSlug: switchSlug,
              projectRoot,
              projectName: path.basename(projectRoot),
              workingDir,
              pid: process.pid,
              startedAt: new Date().toISOString(),
            });
          } catch {
            /* best-effort — discovery degrades gracefully */
          }

          send(ws, {
            type: 'projects.selected',
            payload: {
              root: resolved,
              name: selName || path.basename(resolved),
              message: `Switched to ${selName || path.basename(resolved)}`,
            },
          });

          // Broadcast old-session subagents as stopped so the frontend
          // fleet store cleans them via its normal event pipeline.
          broadcast(clients, {
            type: 'subagent.event',
            payload: {
              kind: 'session_stopped',
              sessionId: oldSessionId,
            },
          });

          // Broadcast updated project info to ALL clients so file
          // explorer / context bar pick up the new root.
          broadcast(clients, {
            type: 'session.start',
            payload: {
              ...(await sessionStartPayload()),
              reset: true,
              clearedSessionId: oldSessionId,
            },
          });
        } catch (err) {
          send(ws, {
            type: 'projects.selected',
            payload: {
              root: selRoot,
              name: selName || path.basename(selRoot),
              message: errMessage(err),
            },
          });
        }
        break;
      }

      // ── Working directory (within current project) ───────────────────

      case 'working_dir.set': {
        const { path: newPath } = (msg as { payload: { path: string } }).payload;
        try {
          const resolved = path.resolve(projectRoot, newPath);

          // Guard: must stay inside projectRoot
          if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
            sendResult(ws, false, `Path must stay inside the project root: ${projectRoot}`);
            break;
          }

          try {
            await fs.access(resolved);
            const stat = await fs.stat(resolved);
            if (!stat.isDirectory()) throw new Error('Not a directory');
          } catch {
            sendResult(ws, false, `Directory not found or not accessible: ${resolved}`);
            break;
          }

          workingDir = resolved;
          context.cwd = resolved;

          // Notify all clients so the file explorer and context bar update
          broadcast(clients, {
            type: 'working_dir.changed',
            payload: { cwd: resolved, projectRoot },
          });

          sendResult(ws, true, `Working directory set to ${resolved}`);
        } catch (err) {
          sendResult(ws, false, errMessage(err));
        }
        break;
      }

      // ── Shell open — spawn terminal or file manager at a path ─────────

      case 'shell.open': {
        // Logic lives in `shell-open.ts` so the CLI's `runWebUI` can
        // share the same metacharacter guard + cross-platform spawn
        // chain. See the docstring in shell-open.ts for the security
        // rationale and the fallback chain.
        const result: ShellOpenResult = await handleShellOpen(
          msg.payload as ShellOpenRequest,
          logger,
        );
        sendResult(ws, result.success, result.message);
        break;
      }

      // ── Mailbox operations — project-level inter-agent messaging ────
      case 'mailbox.messages':
        return handleMailboxMessages(
          ws,
          { projectRoot, globalRoot: path.dirname(globalConfigPath) },
          (msg as { payload?: { limit?: number; agentId?: string; unreadOnly?: boolean } }).payload,
        );
      case 'mailbox.agents':
        return handleMailboxAgents(
          ws,
          { projectRoot, globalRoot: path.dirname(globalConfigPath) },
          (msg as { payload?: { onlineOnly?: boolean } }).payload,
        );
      case 'mailbox.clear':
        return handleMailboxClear(
          ws,
          { projectRoot, globalRoot: path.dirname(globalConfigPath) },
        );

      // ── Brain — status, autonomy ceiling, direct decision support ───
      case 'brain.status':
        send(ws, {
          type: 'brain.status',
          payload: { maxAutoRisk: brainSettings.maxAutoRisk, log: brainLog },
        });
        break;
      case 'brain.risk': {
        const level = (msg as { payload?: { level?: string } }).payload?.level ?? '';
        const valid = ['off', 'low', 'medium', 'high', 'all'];
        if (!valid.includes(level)) {
          sendResult(ws, false, `Unknown risk level "${level}". Use: ${valid.join(', ')}.`);
          break;
        }
        brainSettings.maxAutoRisk = level as BrainAutoRisk;
        send(ws, {
          type: 'brain.status',
          payload: { maxAutoRisk: brainSettings.maxAutoRisk, log: brainLog },
        });
        break;
      }
      case 'brain.ask': {
        const question = (msg as { payload?: { question?: string } }).payload?.question?.trim();
        if (!question) {
          sendResult(ws, false, 'Usage: /brain ask <question>');
          break;
        }
        try {
          const decision = await brain.decide({
            id: `brain-ask-${Date.now().toString(36)}`,
            source: 'user',
            question,
            risk: 'medium',
            fallback: 'ask_human',
          });
          send(ws, { type: 'brain.answer', payload: { question, decision } });
        } catch (err) {
          sendResult(ws, false, `Brain consultation failed: ${errMessage(err)}`);
        }
        break;
      }

      default:
        if (msg.type.startsWith('autophase.')) {
          // Delegate all AutoPhase lifecycle messages to the handler
          await autoPhaseHandler.handleMessage(
            msg as { type: string; payload?: Record<string, unknown> },
          );
        } else {
          send(ws, {
            type: 'error',
            payload: { phase: 'handleMessage', message: `Unknown message type: ${msg.type}` },
          });
        }
    }
  }

  // ---- Provider/Key management helpers (extracted to provider-handlers.ts) ----
  const providerHandlers = createProviderHandlers({
    globalConfigPath,
    vault,
    getConfigWriteLock: () => configWriteLock,
    setConfigWriteLock: (p) => {
      configWriteLock = p;
    },
    broadcast,
    clients,
  });

  // HTTP server for the React frontend (port 3456) — see `http-server.ts`
  // for the static-serve, MIME matching, path-traversal guard, and CSP
  // header logic. Constructed here, listen()d below alongside the WS server.
  // `globalRoot` powers the /api/sessions and /api/sessions/:id/agents
  // handlers (read the cross-process SessionRegistry); `apiToken` is the
  // shared auth token the HTTP API requires when bound to a non-loopback
  // host (LAN exposure). Loopback binds skip the token check, mirroring
  // the WS verifyClient loopback-bootstrap policy.
  const httpServer = createHttpServer({
    host: wsHost,
    distDir: path.resolve(import.meta.dirname, '../../dist'),
    wsPort,
    globalRoot: wpaths.globalRoot,
    apiToken: wsToken,
  });
  // httpPort/wsPort were resolved (and possibly auto-advanced) at the top.
  // Base dir for the running-instance registry — keep it next to the rest of
  // the wstack home state (config.json lives here too).
  const registryBaseDir = path.dirname(globalConfigPath);
  httpServer.listen(httpPort, wsHost, () => {
    const openUrl = `http://${wsHost}:${httpPort}`;
    console.log(`[WebUI] HTTP server running on ${openUrl}`);
    // Optionally pop the browser open (best-effort; the URL is always printed).
    if (opts.open) openBrowser(openUrl);
    // Record this instance so `webui --list` (and `~/.wrongstack/
    // webui-instances.json`) show which ports are open for which project.
    // Best-effort: a registry write failure must not affect serving.
    void registerInstance(
      {
        pid: process.pid,
        httpPort,
        wsPort,
        host: wsHost,
        projectRoot,
        projectName: path.basename(projectRoot) || projectRoot,
        startedAt: new Date().toISOString(),
        url: `http://${wsHost}:${httpPort}`,
      },
      registryBaseDir,
    ).catch((err) => console.warn(JSON.stringify({
      level: 'warn',
      event: 'webui.instance_record_failed',
      message: errMessage(err),
      timestamp: new Date().toISOString(),
    })));
  });

  // Graceful shutdown on SIGINT/SIGTERM — see `lifecycle.ts`. The session
  // flush (session_end + close) is passed as a thunk so lifecycle stays
  // decoupled from the session/tokenCounter types.
  registerShutdownHandlers({
    flushSession: async () => {
      await session.append({
        type: 'session_end',
        ts: new Date().toISOString(),
        usage: tokenCounter.total(),
      });
      await session.close();
    },
    clients: () => clients.keys(),
    servers: [httpServer, wssPrimary, wssSecondary],
    // Drop this instance from the registry on a clean exit so the file reflects
    // reality. Crash exits are healed by the next register()/list() prune pass.
    onShutdown: () => {
      brainMonitor.stop();
      if (eternalSubscription) {
        eternalSubscription.dispose();
        eternalSubscription = null;
      }
      return unregisterInstance(process.pid, registryBaseDir);
    },
  });
}
