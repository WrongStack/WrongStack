/**
 * Pre-context backend service construction for the standalone WebUI server.
 *
 * Phase 1f of the god-module split. `startWebUI` previously inlined ~370
 * lines of construction that runs BEFORE `context` exists: modelsRegistry,
 * container, providerRegistry, toolRegistry (+ memory/mailbox tools),
 * MCPRegistry, sessionStore, session, sessionReader, annotationsStore,
 * cross-surface discovery (session registry + fleet notifier + HQ
 * telemetry), tokenCounter, modeStore, customModeStore, skillInstaller,
 * promptLoader, systemPromptBuilder, systemPrompt, provider resolution,
 * and context creation + meta seeding.
 *
 * All of that moves into `createPreContextServices()`. The block is deeply
 * interleaved with the `opts.services?` injection contract (5 injection
 * points) and mutable `let` bindings the route layer swaps at runtime
 * (session, sessionStore, sessionStartedAt, modeId). The factory returns
 * all of these; `startWebUI` keeps the mutable bindings and wraps them
 * into the `state` object exactly as before.
 *
 * No behaviour change.
 */
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import type { Config, Logger } from '@wrongstack/core';
import {
  AgentStatusTracker,
  AnnotationsStore,
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  DEFAULT_SESSION_PRUNE_DAYS,
  DefaultMemoryStore,
  DefaultModelsRegistry,
  DefaultModeStore,
  DefaultPromptLoader,
  DefaultSessionReader,
  DefaultSessionStore,
  DefaultSkillLoader,
  DefaultSystemPromptBuilder,
  DefaultTokenCounter,
  EventBus,
  FleetNotifier,
  GlobalMailbox,
  PromptUsageStore,
  ProviderRegistry,
  SkillInstaller,
  TOKENS,
  ToolRegistry,
  Context,
  applyToolDescriptionModes,
  applyToolResultRenderModes,
  resolveContextWindowPolicy,
  getSessionRegistry,
  makeMailboxTool,
  makeMailInboxTool,
  makeMailSendTool,
  type Container,
  type ConfigStore,
  type ModelsRegistry,
  type Provider,
  type SecretVault,
  type SessionStore,
} from '@wrongstack/core';
import { MCPRegistry } from '@wrongstack/mcp';
import { buildProviderFactoriesFromRegistry } from '@wrongstack/providers';
import { createDefaultContainer } from '@wrongstack/runtime';
import {
  builtinToolsPack,
  configureExecPolicy,
  forgetTool,
  relatedMemoryTool,
  rememberTool,
  searchMemoryTool,
} from '@wrongstack/tools';
import type { WstackPaths } from '@wrongstack/core/utils';
import { projectHash, toErrorMessage, wstackGlobalRoot } from '@wrongstack/core/utils';
import type { WebUIOptions } from './types.js';
import type { CustomModeStore } from './custom-context-modes.js';
import { createCustomModeStore } from './custom-context-modes.js';
import { resolveSetupProvider } from './setup-screen.js';
import { seedContextMeta } from './context-meta.js';

export interface PreContextServicesInput {
  config: Config;
  wpaths: WstackPaths;
  logger: Logger;
  opts: WebUIOptions;
  vault: SecretVault;
  globalConfigPath: string;
  projectRoot: string;
  workingDir: string;
  needsProvider: boolean;
  /** Callback to register/refresh the project in the manifest. */
  touchProject: (root: string, workDir?: string) => Promise<void>;
}

export interface PreContextServices {
  modelsRegistry: ModelsRegistry;
  container: Container;
  configStore: ConfigStore;
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  memoryStore: DefaultMemoryStore;
  events: EventBus;
  mcpRegistry: import('@wrongstack/mcp').MCPRegistry;
  sessionStore: SessionStore;
  sessionReader: DefaultSessionReader;
  annotationsStore: AnnotationsStore;
  session: Awaited<ReturnType<DefaultSessionStore['create']>>;
  sessionStartedAt: number;
  statusTracker: AgentStatusTracker | undefined;
  tokenCounter: DefaultTokenCounter;
  modeStore: DefaultModeStore;
  modeId: string;
  customModeStore: CustomModeStore;
  skillLoader: DefaultSkillLoader | undefined;
  skillInstaller: SkillInstaller | undefined;
  promptsCtx: { promptLoader: DefaultPromptLoader | undefined; promptUsage: PromptUsageStore };
  modelCapabilitiesRef: { current: unknown };
  provider: Provider;
  context: Context;
  needsSetup: boolean;
}

/**
 * Build all pre-context services: registries, stores, session, system
 * prompt, provider, and context. Returns everything `startWebUI` needs
 * for `createAgentServices` (Phase 1c) + route/dispatcher wiring.
 */
export async function createPreContextServices(
  input: PreContextServicesInput,
): Promise<PreContextServices> {
  const { config, wpaths, logger, opts, globalConfigPath, projectRoot, workingDir, needsProvider } = input;

  // ── ModelsRegistry ──
  const modelsRegistry =
    opts.services?.modelsRegistry ??
    new DefaultModelsRegistry({ cacheFile: wpaths.modelsCache, ttlSeconds: 24 * 3600 });

  // ── Container ──
  const container = createDefaultContainer({ config, wpaths, logger, modelsRegistry });
  const configStore = opts.services?.configStore ?? container.resolve(TOKENS.ConfigStore);

  // ── Provider registry ──
  const providerRegistry = new ProviderRegistry();
  try {
    const factories = await buildProviderFactoriesFromRegistry({ registry: modelsRegistry, log: logger });
    for (const f of factories) providerRegistry.register(f);
    console.log('[WebUI] Provider registry loaded:', providerRegistry.list().length, 'providers');
  } catch (err) {
    console.warn(JSON.stringify({ level: 'warn', event: 'webui.provider_registry_load_failed', message: toErrorMessage(err), timestamp: new Date().toISOString() }));
  }

  // ── Tool registry (+ memory + mailbox tools) ──
  const toolRegistry =
    opts.services?.toolRegistry ??
    (() => {
      const r = new ToolRegistry();
      r.registerAllOrThrow([...(builtinToolsPack.tools ?? [])], builtinToolsPack.name);
      return r;
    })();
  const memoryStore = new DefaultMemoryStore({ paths: wpaths });
  if (config.features.memory) {
    toolRegistry.register(rememberTool(memoryStore));
    toolRegistry.register(forgetTool(memoryStore));
    toolRegistry.register(searchMemoryTool(memoryStore));
    toolRegistry.register(relatedMemoryTool(memoryStore));
  }
  const events = opts.services?.events ?? new EventBus();
  events.setLogger(logger);
  toolRegistry.register(makeMailboxTool({ projectDir: wpaths.projectDir, events }));
  toolRegistry.register(makeMailSendTool({ projectDir: wpaths.projectDir, events }));
  toolRegistry.register(makeMailInboxTool({ projectDir: wpaths.projectDir, events }));
  applyToolDescriptionModes(toolRegistry, config.tools?.descriptionMode);
  applyToolResultRenderModes(toolRegistry, config.tools?.resultRenderMode);
  configureExecPolicy(config.tools?.exec ?? {});
  console.log('[WebUI] Tool registry loaded:', toolRegistry.list().length, 'tools');

  // ── MCP registry ──
  const mcpRegistry = new MCPRegistry({ toolRegistry, events, log: logger, cacheDir: wpaths.cacheDir });
  if (config.features.mcp && config.mcpServers) {
    for (const [name, cfg] of Object.entries(config.mcpServers)) {
      if (cfg.enabled === false) continue;
      void mcpRegistry.start({ ...cfg, name }).catch((err) => {
        logger.warn(`MCP server "${name}" failed to start at boot`, err);
      });
    }
  }

  // ── Session store + session ──
  let sessionStore = opts.services?.session ?? new DefaultSessionStore({ dir: wpaths.projectSessions });
  if (!opts.services?.session) {
    sessionStore.prune(DEFAULT_SESSION_PRUNE_DAYS).then((count) => {
      if (count > 0) logger.info(`Pruned ${count} old session${count === 1 ? '' : 's'}.`);
    }).catch(() => undefined);
  }
  const sessionReader = new DefaultSessionReader({ store: sessionStore });
  const annotationsStore = new AnnotationsStore({ dir: wpaths.projectSessions, events });
  const session = await sessionStore.create({ id: '', title: '', model: config.model, provider: config.provider });
  const sessionStartedAt = Date.now();
  console.log('[WebUI] Session created:', session.id);

  // ── Cross-surface discovery ──
  try {
    await input.touchProject(projectRoot, workingDir);
  } catch {
    /* best-effort */
  }
  let statusTracker: AgentStatusTracker | undefined;
  try {
    const registry = getSessionRegistry(wpaths.globalRoot);
    await registry.register({
      sessionId: session.id,
      projectSlug: wpaths.projectSlug,
      projectRoot,
      projectName: path.basename(projectRoot),
      workingDir,
      clientType: 'webui',
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    const fleetNotifier = new FleetNotifier({ baseDir: wpaths.globalRoot, projectRoot, selfPid: process.pid });
    statusTracker = new AgentStatusTracker({
      events,
      registry,
      sessionId: () => session.id,
      onUpdate: () => fleetNotifier.notify(),
    });
    statusTracker.start();

    // ── HQ session telemetry ──
    let stopHqSessionBridge: (() => void) | undefined;
    let hqTelemetryPublisher: { close(): void } | undefined;
    try {
      const { createHqPublisherFromEnv, startSessionTelemetryBridge } = await import('@wrongstack/core');
      const hqTelemetry = createHqPublisherFromEnv({
        clientKind: 'webui',
        projectRoot,
        projectName: path.basename(projectRoot),
        appConfig: config as never as Parameters<typeof createHqPublisherFromEnv>[0]['appConfig'],
        socketFactory: (url: string) => new WebSocket(url) as unknown as import('@wrongstack/core').HqSocketLike,
      });
      if (hqTelemetry) {
        hqTelemetry.connect();
        hqTelemetryPublisher = hqTelemetry;
        stopHqSessionBridge = startSessionTelemetryBridge({
          publisher: hqTelemetry, events, sessionId: session.id, projectRoot,
          projectName: path.basename(projectRoot), globalRoot: wpaths.globalRoot,
          initialAgents: statusTracker?.getAgents(), startedAt: new Date().toISOString(),
        });
      }
    } catch {
      /* telemetry optional */
    }
    const stopTracking = async () => {
      try {
        fleetNotifier.dispose();
        await registry.markClosing();
        statusTracker?.stop();
        stopHqSessionBridge?.();
        hqTelemetryPublisher?.close();
      } catch {
        /* ignore */
      }
    };
    process.once('beforeExit', () => { void stopTracking(); });
    process.once('SIGINT', () => { void stopTracking(); });
    process.once('SIGTERM', () => { void stopTracking(); });
  } catch {
    /* best-effort — discovery degrades gracefully */
  }

  // ── Token counter ──
  let context: Context;
  const tokenCounter = new DefaultTokenCounter({
    registry: modelsRegistry,
    providerId: config.provider,
    events,
    sessionId: () => context?.session?.id ?? session.id,
  });

  // ── Mode store ──
  const modeStore = new DefaultModeStore({ directory: wpaths.configDir });
  const activeMode = await modeStore.getActiveMode();
  const modeId = activeMode?.id ?? 'default';
  const modePrompt = activeMode?.prompt ?? '';

  // ── Custom context modes ──
  const customModeStore = createCustomModeStore(wpaths.configDir);
  await customModeStore.load();
  console.log('[WebUI] Custom context modes loaded:', customModeStore.list().filter((m) => (m as { custom?: boolean }).custom).length, 'custom');

  // ── Model capabilities ref ──
  const resolvedModel = await modelsRegistry.getModel(config.provider, config.model);
  const modelCapabilities = resolvedModel?.capabilities
    ? { maxContextTokens: resolvedModel.capabilities.maxContext, supportsTools: resolvedModel.capabilities.tools, supportsVision: resolvedModel.capabilities.vision, supportsReasoning: resolvedModel.capabilities.reasoning }
    : undefined;
  const modelCapabilitiesRef: { current: typeof modelCapabilities } = { current: modelCapabilities };

  // ── Skill loader/installer ──
  const skillLoader = config.features.skills ? new DefaultSkillLoader({ paths: wpaths }) : undefined;
  const skillInstaller = config.features.skills
    ? new SkillInstaller({
        manifestPath: path.join(wstackGlobalRoot(), 'installed-skills.json'),
        projectSkillsDir: path.join(projectRoot, '.wrongstack', 'skills'),
        globalSkillsDir: path.join(wstackGlobalRoot(), 'skills'),
        projectHash: projectHash(projectRoot),
        skillLoader,
      })
    : undefined;

  // ── Prompt library ──
  const promptsEnabled = config.features.prompts !== false;
  const bundledPromptsDir = promptsEnabled
    ? (() => {
        try {
          const req = createRequire(import.meta.url);
          return path.join(path.dirname(req.resolve('@wrongstack/core/package.json')), 'data', 'prompts');
        } catch {
          return undefined;
        }
      })()
    : undefined;
  const promptLoader = promptsEnabled ? new DefaultPromptLoader({ paths: wpaths, bundledDir: bundledPromptsDir }) : undefined;
  const promptUsage = new PromptUsageStore(wpaths.promptUsage);
  const promptsCtx = { promptLoader, promptUsage };

  // ── System prompt builder ──
  const systemPromptBuilder = new DefaultSystemPromptBuilder({
    memoryStore, skillLoader, modeStore, modeId, modePrompt,
    modelCapabilities: () => modelCapabilitiesRef.current,
    instructionPaths: { globalDir: wpaths.globalInstructions, projectDir: wpaths.inProjectInstructions },
  });

  // ── System prompt (with online agents from the shared mailbox) ──
  let onlineAgents: import('@wrongstack/core').MailboxAgentStatus[] = [];
  try {
    const systemMailbox = new GlobalMailbox(wpaths.projectDir);
    onlineAgents = await systemMailbox.getAgentStatuses();
  } catch {
    /* Non-fatal — mailbox errors should not block prompt building */
  }
  const systemPrompt = await systemPromptBuilder.build({
    cwd: projectRoot, projectRoot, tools: toolRegistry.list(),
    provider: config.provider, model: config.model, onlineAgents,
  });

  // ── Provider resolution ──
  const resolvedProvider = resolveSetupProvider({ config, needsProvider, providerRegistry });
  const provider = resolvedProvider.provider;
  const needsSetup = resolvedProvider.needsSetup;

  // ── Context ──
  context = new Context({
    systemPrompt, provider, session, signal: new AbortController().signal,
    tokenCounter, cwd: workingDir, projectRoot, model: config.model,
  });
  const initialContextPolicy = resolveContextWindowPolicy(config.context);
  context.meta['contextWindowMode'] = initialContextPolicy.id;
  context.meta['contextWindowPolicy'] = initialContextPolicy;
  seedContextMeta(config, context);

  return {
    modelsRegistry, container, configStore, providerRegistry, toolRegistry,
    memoryStore, events, mcpRegistry, sessionStore, sessionReader, annotationsStore,
    session, sessionStartedAt, statusTracker, tokenCounter, modeStore, modeId,
    customModeStore, skillLoader, skillInstaller, promptsCtx, modelCapabilitiesRef,
    provider, context, needsSetup,
  };
}
