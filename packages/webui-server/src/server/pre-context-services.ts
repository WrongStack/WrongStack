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
import { Context, DefaultSystemPromptBuilder } from '@wrongstack/core/agent';
import {
  getSharedProjectMailbox,
  makeFleetStatusTool,
  makeMailboxTool,
  makeMailInboxTool,
  makeMailSendTool,
} from '@wrongstack/core/coordination';
import { DefaultPromptLoader, DefaultSkillLoader } from '@wrongstack/core/execution';
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { type Container, EventBus, TOKENS } from '@wrongstack/core/kernel';
import { DefaultModelsRegistry, DefaultModeStore } from '@wrongstack/core/models';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { SkillInstaller } from '@wrongstack/core/skills';
import {
  type AgentStatusTracker,
  AnnotationsStore,
  DefaultSessionReader,
  DefaultSessionStore,
  getSessionRegistry,
  PromptUsageStore,
} from '@wrongstack/core/storage';
import {
  type Config,
  type ConfigStore,
  DEFAULT_SESSION_PRUNE_DAYS,
  type Logger,
  type MemoryPort,
  type ModelsRegistry,
  normalizeTokenSavingTier,
  type Provider,
  resolveContextWindowPolicy,
  type SecretVault,
  type SessionStore,
} from '@wrongstack/core/types';
import {
  configureChildEnvGitIdentity,
  sessionScopedPath,
  toErrorMessage,
  type WstackPaths,
} from '@wrongstack/core/utils';
import {
  createVaultBackedMcpAuthorizationProviderFactory,
  MCPAuthorizationManager,
  MCPRegistry,
  MCPVaultTokenStore,
} from '@wrongstack/mcp';
import {
  buildProviderFactoriesFromRegistry,
  installCatalogModelOutputLimits,
} from '@wrongstack/providers';
import { createDefaultContainer } from '@wrongstack/runtime';
import { registerCanonicalHostTools } from '@wrongstack/runtime/tool-registration';
import { configureDangerBypass, configureExecPolicy } from '@wrongstack/tools';
import { attachSessionKanbanMirror, hydrateSessionKanban } from '@wrongstack/tools/session-kanban';
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
  const { config, wpaths, logger, opts, vault, projectRoot, workingDir, needsProvider } = input;

  // ── ModelsRegistry ──
  const modelsRegistry =
    opts.services?.modelsRegistry ??
    new DefaultModelsRegistry({
      cacheFile: wpaths.modelsCache,
      ttlSeconds: 0,
      overlayUrl: GITHUB_PROVIDERS_OVERLAY_URL,
      overlayCacheFile: wpaths.modelsOverlayCache,
    });

  if (!opts.services?.modelsRegistry) {
    try {
      await modelsRegistry.refresh();
      logger.info('models.dev catalog refreshed');
    } catch (err) {
      logger.warn(`models.dev refresh failed (${toErrorMessage(err)}); using cached catalog`);
    }
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

  // ── Container ──
  const container = createDefaultContainer({ config, wpaths, logger, modelsRegistry, events });
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

  // ── Tool registry (+ memory + mailbox tools) ──
  const toolRegistry = opts.services?.toolRegistry ?? new ToolRegistry();
  const memoryStore = container.resolve(TOKENS.MemoryStore);
  await memoryStore.initialize();
  if (!opts.services?.toolRegistry) {
    registerCanonicalHostTools({
      registry: toolRegistry,
      tier: normalizeTokenSavingTier(config.features.tokenSavingMode),
      memory: { enabled: config.features.memory, store: memoryStore },
      nextSteps: { enabled: config.tools?.nextsteps?.enabled === true },
      coordinationTools: [
        makeMailboxTool({ projectDir: wpaths.projectDir, events }),
        makeMailSendTool({ projectDir: wpaths.projectDir, events }),
        makeMailInboxTool({ projectDir: wpaths.projectDir, events }),
        makeFleetStatusTool({ projectDir: wpaths.projectDir, events }),
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
  const mcpAuthorizationManager = new MCPAuthorizationManager({ store: mcpTokenStore });
  const mcpRegistry = new MCPRegistry({
    toolRegistry,
    events,
    log: logger,
    cacheDir: wpaths.cacheDir,
    authorizationProviderFactory: createVaultBackedMcpAuthorizationProviderFactory({
      store: mcpTokenStore,
    }),
    authorizationManager: mcpAuthorizationManager,
  });
  if (config.features.mcp && config.mcpServers) {
    for (const [name, cfg] of Object.entries(config.mcpServers)) {
      void mcpRegistry.start({ ...cfg, name }).catch((err) => {
        logger.warn(`MCP server "${name}" failed to start at boot`, err);
      });
    }
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

  // ── Skill loader/installer ──
  const skillLoader = config.features.skills
    ? new DefaultSkillLoader({ paths: wpaths })
    : undefined;
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
  const bundledPromptsDir = promptsEnabled
    ? (() => {
        try {
          const req = createRequire(import.meta.url);
          return path.join(
            path.dirname(req.resolve('@wrongstack/core/package.json')),
            'data',
            'prompts',
          );
        } catch {
          return undefined;
        }
      })()
    : undefined;
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
    tokenSavingMode: config.features.tokenSavingMode,
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
  const systemPrompt = await systemPromptBuilder.build({
    cwd: projectRoot,
    projectRoot,
    tools: toolRegistry.listForProvider(),
    catalogTools: toolRegistry.list(),
    provider: config.provider,
    model: config.model,
    onlineAgents,
  });

  // ── Provider resolution ──
  const resolvedProvider = resolveSetupProvider({ config, needsProvider, providerRegistry });
  const provider = resolvedProvider.provider;
  const needsSetup = resolvedProvider.needsSetup;

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
