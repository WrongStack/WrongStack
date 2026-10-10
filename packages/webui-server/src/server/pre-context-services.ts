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

import { createRequire } from 'node:module';
import * as path from 'node:path';
import {
  Context,
  DefaultSystemPromptBuilder,
  providerToolsForVariant,
} from '@wrongstack/core/agent';
import type { AgentStatusTracker } from '@wrongstack/core/coordination';
import {
  getSharedProjectMailbox,
  makeFleetStatusTool,
  makeMailboxTool,
  makeMailInboxTool,
  makeMailSendTool,
  makeSessionNoteTool,
} from '@wrongstack/core/coordination';
import { DefaultPromptLoader, DefaultSkillLoader } from '@wrongstack/core/execution';
import { DefaultTokenCounter, resolveMcpServerConfig } from '@wrongstack/core/infrastructure';
import { type Container, EventBus, TOKENS } from '@wrongstack/core/kernel';
import { DefaultModelsRegistry, DefaultModeStore, startCatalog } from '@wrongstack/core/models';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { SkillInstaller } from '@wrongstack/core/skills';
import {
  AnnotationsStore,
  attachScoutToolLearning,
  DefaultSessionReader,
  DefaultSessionStore,
  getSessionRegistry,
  PromptUsageStore,
  seedScoutLearnedTools,
} from '@wrongstack/core/storage';
import {
  createMcpControlTool,
  createMcpUseTool,
  createSessionRenameTool,
  SESSION_RENAME_TOOL_NAME,
} from '@wrongstack/core/tools';
import {
  type Config,
  type ConfigStore,
  DEFAULT_SESSION_PRUNE_DAYS,
  type Logger,
  type MemoryPort,
  type ModelsRegistry,
  type Provider,
  resolveContextWindowPolicy,
  resolveTokenSavingTier,
  type SecretVault,
  type SessionStore,
} from '@wrongstack/core/types';
import {
  configureChildEnvGitIdentity,
  sessionScopedPath,
  toErrorMessage,
  type WstackPaths,
  wrongstackPackageJsonPath,
} from '@wrongstack/core/utils';
import {
  createVaultBackedMcpAuthorizationProviderFactory,
  MCPAuthorizationManager,
  type MCPAuthorizationStateEvent,
  MCPRegistry,
  MCPVaultTokenStore,
} from '@wrongstack/mcp';
import {
  buildProviderFactoriesFromRegistry,
  installCatalogModelOutputLimits,
  setStreamTimeoutDefaults,
} from '@wrongstack/providers';
import { createDefaultContainer } from '@wrongstack/runtime';
import { registerCanonicalHostTools } from '@wrongstack/runtime/tool-registration';
import { configureDangerBypass, configureExecPolicy } from '@wrongstack/tools';
import { attachSessionKanbanMirror, hydrateSessionKanban } from '@wrongstack/tools/session-kanban';
import type { VectorMemoryStore } from '@wrongstack/vector-memory';
import { seedContextMeta } from './context-meta.js';
import type { CustomModeStore } from './custom-context-modes.js';
import { createCustomModeStore } from './custom-context-modes.js';
import { discoverAndMergeWebuiProviders } from './model-auto-discovery.js';
import { resolveProviderModelMetadata } from './model-catalog.js';
import { resolveSetupProvider } from './setup-screen.js';
import {
  createStandaloneSessionIdentityLifecycle,
  type StandaloneSessionIdentityLifecycle,
} from './standalone-session-identity.js';
import type { WebUIOptions } from './types.js';

const GITHUB_PROVIDERS_OVERLAY_URL =
  'https://raw.githubusercontent.com/WrongStack/WrongStack/main/packages/cli/data/providers.json';

function resolveBundledSkillsDir(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const corePkg = wrongstackPackageJsonPath('@wrongstack/core', (id) => req.resolve(id));
    return path.join(path.dirname(corePkg), 'skills');
  } catch {
    return undefined;
  }
}

function resolveBundledPromptsDir(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const corePkg = wrongstackPackageJsonPath('@wrongstack/core', (id) => req.resolve(id));
    return path.join(path.dirname(corePkg), 'data', 'prompts');
  } catch {
    return undefined;
  }
}

interface PreContextServicesInput {
  config: Config;
  wpaths: WstackPaths;
  logger: Logger;
  opts: WebUIOptions;
  vault: SecretVault;
  globalConfigPath: string;
  projectRoot: string;
  workingDir: string;
  needsProvider: boolean;
  /** Optional semantic-memory store created by the standalone host before registry composition. */
  vectorMemoryStore?: VectorMemoryStore | undefined;
  /** Callback to register/refresh the project in the manifest. */
  touchProject: (root: string, workDir?: string) => Promise<void>;
}

interface PreContextServices {
  modelsRegistry: ModelsRegistry;
  container: Container;
  configStore: ConfigStore;
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  memoryStore: MemoryPort;
  events: EventBus;
  mcpRegistry: import('@wrongstack/mcp').MCPRegistry;
  sessionStore: SessionStore;
  sessionReader: DefaultSessionReader;
  annotationsStore: AnnotationsStore;
  session: Awaited<ReturnType<DefaultSessionStore['create']>>;
  sessionStartedAt: number;
  statusTracker: AgentStatusTracker | undefined;
  sessionIdentity: StandaloneSessionIdentityLifecycle;
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
  const {
    config,
    wpaths,
    logger,
    opts,
    vault,
    globalConfigPath,
    projectRoot,
    workingDir,
    needsProvider,
    vectorMemoryStore,
  } = input;

  // ── ModelsRegistry ──
  const modelsRegistry =
    opts.services?.modelsRegistry ??
    new DefaultModelsRegistry({
      cacheFile: wpaths.modelsCache,
      ttlSeconds: 0,
      overlayUrl: GITHUB_PROVIDERS_OVERLAY_URL,
      overlayCacheFile: wpaths.modelsOverlayCache,
    });

  // Same cache-first policy as the CLI boot: a usable cache serves the UI at
  // once and the catalog refreshes in the background (and periodically — the
  // WebUI server is long-lived). An injected registry belongs to the host,
  // which owns its refresh schedule.
  if (!opts.services?.modelsRegistry) {
    await startCatalog({ registry: modelsRegistry, logger });
  }

  // Discovery FIRST, matching the CLI boot order: it injects runtime-discovered
  // models into the catalog, and the output-limit index below is built from
  // that catalog. Running it the other way round leaves every discovered
  // model's ceiling out of the index.
  try {
    await discoverAndMergeWebuiProviders({
      config,
      registry: modelsRegistry,
      cacheDir: path.dirname(wpaths.modelsCache),
      logger,
    });
  } catch (err) {
    logger.debug(`provider auto-discovery skipped: ${toErrorMessage(err)}`);
  }

  // Stream watchdog budgets. Every provider reads these at construction, so
  // they must be installed before the first one is built — the composite
  // providers never forwarded per-instance stream options to their delegates,
  // which is why this is process state rather than a factory argument.
  setStreamTimeoutDefaults(config.modelRuntime?.streaming);

  // Same per-request output-ceiling index the CLI installs. Without it every
  // wire body falls back to the adapters' 8192 literal whenever the provider
  // instance wasn't built for the model being requested.
  try {
    await installCatalogModelOutputLimits({
      registry: modelsRegistry,
      getConfig: () => config,
      log: (message) => logger.debug(message),
    });
  } catch (err) {
    logger.debug(`model output-limit index skipped: ${toErrorMessage(err)}`);
  }

  const events = opts.services?.events ?? new EventBus();
  events.setLogger(logger);

  const bundledSkillsDir = config.features.skills ? resolveBundledSkillsDir() : undefined;
  const bundledPromptsDir =
    config.features.prompts !== false ? resolveBundledPromptsDir() : undefined;

  // ── Container ──
  const container = createDefaultContainer({
    config,
    wpaths,
    logger,
    modelsRegistry,
    events,
    bundledSkillsDir,
    bundledPromptsDir,
  });
  const configStore = opts.services?.configStore ?? container.resolve(TOKENS.ConfigStore);

  // ── Provider registry ──
  const providerRegistry = new ProviderRegistry();
  try {
    const factories = await buildProviderFactoriesFromRegistry({
      registry: modelsRegistry,
      log: logger,
    });
    for (const f of factories) providerRegistry.register(f);
    console.log('[WebUI] Provider registry loaded:', providerRegistry.list().length, 'providers');
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'webui.provider_registry_load_failed',
        message: toErrorMessage(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }

  // ── Model capabilities ref ──
  const resolvedModel = await resolveProviderModelMetadata(
    modelsRegistry,
    config.provider,
    config.model,
    config.providers?.[config.provider],
  );
  const modelCapabilities = resolvedModel?.capabilities
    ? {
        maxContextTokens: resolvedModel.capabilities.maxContext,
        supportsTools: resolvedModel.capabilities.tools,
        supportsVision: resolvedModel.capabilities.vision,
        supportsReasoning: resolvedModel.capabilities.reasoning,
      }
    : undefined;
  const modelCapabilitiesRef: { current: typeof modelCapabilities } = {
    current: modelCapabilities,
  };

  // One tier decision per session, shared by the tool registry AND the prompt
  // builder below. `'auto'` (the config default) expands two different ways —
  // window-blind to `'medium'` via `normalizeTokenSavingTier`, window-aware to
  // `'minimal'` via `resolveTokenSavingTier` — and the registry used the first
  // while the builder used the second, so a default session described a
  // `'minimal'` tool surface it did not actually have. The model capabilities
  // above are resolved BEFORE the registry for exactly this reason.
  const tokenSavingTier = resolveTokenSavingTier(
    config.features.tokenSavingMode,
    modelCapabilities?.maxContextTokens,
  );

  // ── Skill loader ── created before the registry so the `skill` tool the
  // progressive manifest points at is registered alongside it.
  const skillLoader = config.features.skills
    ? new DefaultSkillLoader({
        paths: wpaths,
        bundledDir: bundledSkillsDir,
        readClaudeSkills: config.skills?.readClaudeSkills,
        foreignSources: config.skills?.foreignSources,
        extraDirs: config.skills?.extraDirs,
      })
    : undefined;

  // ── Tool registry (+ memory + mailbox tools) ──
  const toolRegistry = opts.services?.toolRegistry ?? new ToolRegistry();
  const memoryStore = container.resolve(TOKENS.MemoryStore);
  await memoryStore.initialize();
  if (!opts.services?.toolRegistry) {
    registerCanonicalHostTools({
      registry: toolRegistry,
      tier: tokenSavingTier,
      memory: { enabled: config.features.memory, store: memoryStore },
      vectorMemory: vectorMemoryStore ? { store: vectorMemoryStore } : undefined,
      nextSteps: { enabled: config.tools?.nextsteps?.enabled === true },
      skillLoader,
      coordinationTools: [
        makeMailboxTool({ projectDir: wpaths.projectDir, events }),
        makeMailSendTool({ projectDir: wpaths.projectDir, events }),
        makeMailInboxTool({ projectDir: wpaths.projectDir, events }),
        makeFleetStatusTool({ projectDir: wpaths.projectDir, events }),
        makeSessionNoteTool({ projectDir: wpaths.projectDir, events }),
      ],
      descriptionMode: config.tools?.descriptionMode,
      resultRenderMode: config.tools?.resultRenderMode,
      disabledTools: config.tools?.disabledTools,
    });
  }
  configureExecPolicy(config.tools?.exec ?? {});
  configureDangerBypass(config.tools?.exec?.danger ?? {});
  // Commit identity for every git-touching child process. Trusted-config-only:
  // the loader strips `git` from repo-committed in-project configs.
  configureChildEnvGitIdentity(config.git?.identity ?? null);
  console.log('[WebUI] Tool registry loaded:', toolRegistry.list().length, 'tools');

  // ── MCP registry ──
  const mcpTokenStore = new MCPVaultTokenStore(
    path.join(wpaths.projectDir, 'mcp-auth.json'),
    vault,
  );
  // Same listener the CLI host installs: the WebUI forwards this event to the
  // MCP settings panel so an expired server is visible instead of silent.
  const onMcpAuthorizationState = (event: MCPAuthorizationStateEvent): void => {
    events.emit('mcp.server.auth_state', event);
    if (event.state === 'reauth_required') {
      logger.warn(`MCP server "${event.serverName}" needs reauthorization`);
    }
  };
  const mcpAuthorizationManager = new MCPAuthorizationManager({
    store: mcpTokenStore,
    onStateChange: onMcpAuthorizationState,
  });
  const mcpRegistry = new MCPRegistry({
    toolRegistry,
    events,
    log: logger,
    cacheDir: wpaths.cacheDir,
    // The WebUI host serves `projectRoot` but may run from any directory;
    // presets resolve `--project-root .` against the spawn cwd.
    cwd: wpaths.projectRoot,
    authorizationProviderFactory: createVaultBackedMcpAuthorizationProviderFactory({
      store: mcpTokenStore,
      onStateChange: onMcpAuthorizationState,
    }),
    authorizationManager: mcpAuthorizationManager,
  });
  if (config.features.mcp && config.mcpServers) {
    for (const [name, cfg] of Object.entries(config.mcpServers)) {
      // Merge the preset like the CLI boot does: a bare `{ enabled: true }`
      // preset entry has no transport/command of its own.
      const resolved = resolveMcpServerConfig(name, cfg);
      if (!resolved) {
        logger.warn(`MCP server "${name}" has no transport and matches no preset — skipped`);
        continue;
      }
      void mcpRegistry.start(resolved).catch((err) => {
        logger.warn(`MCP server "${name}" failed to start at boot`, err);
      });
    }
  }

  // MCPRegistry owns the connections, but these gateways are what make a
  // token-saving model able to discover a server schema and invoke a dormant
  // server without exposing every MCP tool in every provider request.
  const disabledTools = new Set(config.tools?.disabledTools ?? []);
  const exposeMcpGateway = (name: string) => {
    if (tokenSavingTier !== 'off') toolRegistry.exposeToProvider(name);
  };
  if (!disabledTools.has('mcp_control')) {
    toolRegistry.registerDefault(
      createMcpControlTool({
        getConfig: () => configStore.get(),
        configPath: globalConfigPath,
        registry: mcpRegistry,
      }),
    );
    exposeMcpGateway('mcp_control');
  }
  if (!disabledTools.has('mcp_use')) {
    toolRegistry.registerDefault(createMcpUseTool({ registry: mcpRegistry, toolRegistry }));
    exposeMcpGateway('mcp_use');
  }

  // ── Session store + session ──
  const sessionStore =
    opts.services?.session ??
    new DefaultSessionStore({
      dir: wpaths.projectSessions,
      projectRoot: wpaths.projectRoot,
      // Cross-process guard for delete(): refuses to remove a session that a
      // live terminal/TUI/WebUI in this project is using.
      isSessionInUse: async (sessionId) => {
        try {
          const registry = getSessionRegistry(wpaths.globalRoot);
          const live = await registry.listByProject(wpaths.projectSlug);
          const hit = live.find((e) => e.sessionId === sessionId);
          if (hit) {
            return `active in ${hit.projectName} (PID ${hit.pid})`;
          }
        } catch {
          // registry unavailable — keep the store usable
        }
        return null;
      },
    });
  if (!opts.services?.session) {
    sessionStore
      .prune(DEFAULT_SESSION_PRUNE_DAYS)
      .then((count) => {
        if (count > 0) logger.info(`Pruned ${count} old session${count === 1 ? '' : 's'}.`);
      })
      .catch(() => undefined);
  }
  const sessionReader = new DefaultSessionReader({ store: sessionStore });
  // The model titles the session it works in (each tab's own session).
  if (!disabledTools.has(SESSION_RENAME_TOOL_NAME)) {
    toolRegistry.registerDefault(
      createSessionRenameTool({
        rename: (sessionId, name) => sessionStore.rename(sessionId, name),
        events,
      }),
    );
    if (tokenSavingTier !== 'off') toolRegistry.exposeToProvider(SESSION_RENAME_TOOL_NAME);
  }
  const annotationsStore = new AnnotationsStore({ dir: wpaths.projectSessions, events });
  const session = await sessionStore.create({
    id: '',
    title: '',
    model: config.model,
    provider: config.provider,
  });
  const sessionStartedAt = Date.now();
  console.log('[WebUI] Session created:', session.id);

  // ── Cross-surface discovery ──
  try {
    await input.touchProject(projectRoot, workingDir);
  } catch {
    /* best-effort */
  }
  const sessionIdentity = await createStandaloneSessionIdentityLifecycle({
    config,
    events,
    logger,
    paths: {
      globalRoot: wpaths.globalRoot,
      projectRoot,
      projectSlug: wpaths.projectSlug,
    },
    workingDir,
    initialSessionId: session.id,
  });
  const statusTracker = sessionIdentity.statusTracker;

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
  console.log(
    '[WebUI] Custom context modes loaded:',
    customModeStore.list().filter((m) => (m as { custom?: boolean }).custom).length,
    'custom',
  );

  // ── Skill installer (loader is created before the tool registry) ──
  const skillInstaller = config.features.skills
    ? new SkillInstaller({
        manifestPath: path.join(wpaths.configDir, 'installed-skills.json'),
        projectSkillsDir: wpaths.inProjectSkills,
        globalSkillsDir: wpaths.globalSkills,
        projectHash: wpaths.projectHash,
        skillLoader,
      })
    : undefined;

  // ── Prompt library ──
  const promptsEnabled = config.features.prompts !== false;
  const promptLoader = promptsEnabled
    ? new DefaultPromptLoader({ paths: wpaths, bundledDir: bundledPromptsDir })
    : undefined;
  const promptUsage = new PromptUsageStore(wpaths.promptUsage);
  const promptsCtx = { promptLoader, promptUsage };

  // ── System prompt builder ──
  const systemPromptBuilder = new DefaultSystemPromptBuilder({
    memoryStore,
    // SAGE's turn middleware is the single memory-injection channel;
    // don't also inject a static memory section here (avoids double injection).
    injectMemory: false,
    skillLoader,
    modeStore,
    modeId,
    modePrompt,
    modelCapabilities: () => modelCapabilitiesRef.current,
    tokenSavingMode: tokenSavingTier,
    instructionPaths: {
      globalDir: wpaths.globalInstructions,
      projectDir: wpaths.inProjectInstructions,
      systemVariant: config.systemPrompt?.variant,
    },
  });
  if (container.has(TOKENS.SystemPromptBuilder)) {
    container.override(TOKENS.SystemPromptBuilder, () => systemPromptBuilder, { owner: 'webui' });
  } else {
    container.bind(TOKENS.SystemPromptBuilder, () => systemPromptBuilder, { owner: 'webui' });
  }

  // ── System prompt (with online agents from the shared mailbox) ──
  let onlineAgents: import('@wrongstack/core/coordination').MailboxAgentStatus[] = [];
  try {
    const systemMailbox = getSharedProjectMailbox(wpaths.projectDir);
    onlineAgents = await systemMailbox.getAgentStatuses();
  } catch {
    /* Non-fatal — mailbox errors should not block prompt building */
  }
  // Resolve the provider before prompt tool conditions so configured tool caps
  // apply to the boot prompt as well as subsequent agent requests.
  const resolvedProvider = resolveSetupProvider({ config, needsProvider, providerRegistry });
  const provider = resolvedProvider.provider;
  const needsSetup = resolvedProvider.needsSetup;
  const systemPrompt = await systemPromptBuilder.build({
    cwd: projectRoot,
    projectRoot,
    tools: providerToolsForVariant(toolRegistry, config.systemPrompt?.variant, undefined, provider),
    catalogTools: toolRegistry.list(),
    provider: config.provider,
    model: config.model,
    onlineAgents,
  });

  // ── Context ──
  context = new Context({
    systemPrompt,
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter,
    cwd: workingDir,
    projectRoot,
    model: config.model,
  });
  context.meta['promptOnlineAgents'] = onlineAgents;
  const initialContextPolicy = resolveContextWindowPolicy(
    config.context,
    undefined,
    provider.capabilities?.maxContext,
  );
  context.meta['contextWindowMode'] = initialContextPolicy.id;
  context.meta['contextWindowPolicy'] = initialContextPolicy;
  context.state.setMeta(
    'plan.path',
    sessionScopedPath(wpaths.projectSessions, session.id, '.plan.json'),
  );
  context.state.setMeta(
    'task.path',
    sessionScopedPath(wpaths.projectSessions, session.id, '.tasks.json'),
  );
  await hydrateSessionKanban(context);
  attachSessionKanbanMirror(context);
  seedContextMeta(config, context);
  // Scout: promote the deferred tools this project keeps calling through
  // `tool_use`; new tabs inherit the list with the leader's project meta.
  seedScoutLearnedTools(context.meta, wpaths.projectDir);
  attachScoutToolLearning(events, wpaths.projectDir);

  return {
    modelsRegistry,
    container,
    configStore,
    providerRegistry,
    toolRegistry,
    memoryStore,
    events,
    mcpRegistry,
    sessionStore,
    sessionReader,
    annotationsStore,
    session,
    sessionStartedAt,
    statusTracker,
    sessionIdentity,
    tokenCounter,
    modeStore,
    modeId,
    customModeStore,
    skillLoader,
    skillInstaller,
    promptsCtx,
    modelCapabilitiesRef,
    provider,
    context,
    needsSetup,
  };
}
