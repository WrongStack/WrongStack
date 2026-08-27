/**
 * WebUI route-table construction.
 *
 * Phase 1a of the god-module split (issue: God-modules >1500 lines).
 * `startWebUI` in `./index.ts` previously inlined the construction of
 * 13 `*Routes` records (provider / session / project / mode / prefs /
 * shell-git / mailbox / mcp / brain / goal / specs / sdd-board /
 * sdd-wizard). They totalled 947 lines — the bulk of the file — and
 * were glued together by closure capture of mutable state (config,
 * projectRoot, workingDir, session, …).
 *
 * This module moves that block into a single `buildRoutes()` function.
 * The closures now read live values through `WebuiMutableState` getters
 * and write them through setters, exactly the way the original code
 * captured them by reference. No behaviour change: comments, message
 * shapes, ordering, and validation are preserved verbatim.
 *
 * The `*RouteHandlers` interfaces already living next door
 * (provider-routes.ts, prefs-routes.ts, …) define the type contracts
 * this file fulfils.
 */
import path from 'node:path';
import type { Agent, AgentPipelines, Context } from '@wrongstack/core/agent';
import type { ObservableBrainArbiter } from '@wrongstack/core/coordination';
import type {
  AutoCompactionMiddleware,
  BrainAutoRisk,
  BrainRuntime,
} from '@wrongstack/core/execution';
import type { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import type { Container, EventBus } from '@wrongstack/core/kernel';
import type { DefaultModeStore } from '@wrongstack/core/models';
import type { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import type { SkillInstaller } from '@wrongstack/core/skills';
import type {
  Compactor,
  ConfigStore,
  Logger,
  MemoryPort,
  ModelsRegistry,
  PermissionPolicy,
  Provider,
  ProviderConfig,
  SecretVault,
  SessionStore,
  SkillLoader,
} from '@wrongstack/core/types';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import type { WebSocket, WebSocketServer } from 'ws';

type Session = Awaited<ReturnType<SessionStore['create']>>;

import type { Config } from '@wrongstack/core/types';
import type { MCPRegistry } from '@wrongstack/mcp';
import { makeProviderFromConfig, withCatalogCapabilities } from '@wrongstack/providers';
import { type AutonomyRouteHandlers, createAutonomyRouteHandlers } from './autonomy-routes.js';
import { patchConfig } from './boot.js';
import {
  type BrainHandlerContext,
  handleBrainAsk,
  handleBrainConfigGet,
  handleBrainConfigSet,
  handleBrainRisk,
  handleBrainStatus,
} from './brain-handlers.js';
import type { BrainRouteHandlers } from './brain-routes.js';
import type { CollaborationWebSocketHandler } from './collaboration-ws-handler.js';
import { handleConfigDoctor } from './config-doctor.js';
import type { CustomModeStore } from './custom-context-modes.js';
import { emitFallbackChoice } from './fallback-choice.js';
import {
  handleGitChanges,
  handleGitCommit,
  handleGitDiff,
  handleGitDiscard,
  handleGitInfo,
  handleGitStage,
  handleGitUnstage,
} from './git-handlers.js';
import type { GoalRouteHandlers } from './goal-routes.js';
import type { GoalWebSocketHandler } from './goal-ws-handler.js';
import { createMailboxRouteHandlers, type MailboxRouteHandlers } from './mailbox-routes.js';
import {
  handleMcpAdd,
  handleMcpDisable,
  handleMcpDiscover,
  handleMcpEnable,
  handleMcpList,
  handleMcpPromptGet,
  handleMcpPrompts,
  handleMcpRemove,
  handleMcpResourceRead,
  handleMcpResources,
  handleMcpRestart,
  handleMcpSleep,
  handleMcpUpdate,
  handleMcpWake,
} from './mcp-handlers.js';
import type { McpRouteHandlers } from './mcp-routes.js';
import { createModeHandlers } from './mode-handlers.js';
import type { ModeRouteHandlers } from './mode-routes.js';
import { createModelOperations } from './model-operations.js';
import type { PendingConfirm } from './pending-confirms.js';
import { prefSnapshot as prefSnapshotImpl } from './pref-helpers.js';
import type { PrefsHandlerContext } from './prefs-handlers.js';
import { createPrefsRouteHandlers, type PrefsRouteHandlers } from './prefs-routes.js';
import { authorizeWebUIAction } from './privileged-actions.js';
import { createProjectHandlers } from './project-handlers.js';
import type { ProjectRouteHandlers } from './project-routes.js';
import { createProviderHandlers } from './provider-handlers.js';
import type { ProviderRouteHandlers } from './provider-routes.js';
import {
  applyWrongProxyPrefs as applyWrongProxyPrefsRuntime,
  routeProviderCfgThroughProxy,
} from './proxy-runtime.js';
import type { SddBoardRouteHandlers } from './sdd-board-routes.js';
import type { SddBoardWebSocketHandler } from './sdd-board-ws-handler.js';
import type { SddWizardRouteHandlers } from './sdd-wizard-routes.js';
import type { SddWizardWebSocketHandler } from './sdd-wizard-ws-handler.js';
import { createSessionHandlers } from './session-handlers.js';
import type { SessionRouteHandlers } from './session-routes.js';
import type { ShellGitRouteHandlers } from './shell-git-routes.js';
import {
  handleShellOpen,
  normalizeShellOpenTarget,
  type ShellOpenResult,
  type ShellOpenTarget,
} from './shell-open.js';
import type { SpecsRouteHandlers } from './specs-routes.js';
import type { SpecsWebSocketHandler } from './specs-ws-handler.js';
import type { SessionIdentityTarget } from './standalone-session-identity.js';
import { rebuildSystemPrompt } from './system-prompt-rebuild.js';
import type { TerminalWebSocketHandler } from './terminal-ws-handler.js';
import type { ConnectedClient } from './types.js';
import type { WorktreeWebSocketHandler } from './worktree-ws-handler.js';
import {
  validateGitCommitPayload,
  validateGitDiffPayload,
  validateGitDiscardPayload,
  validateGitStagePayload,
  validateGitUnstagePayload,
  validateShellOpenPayload,
} from './ws-payload-validation.js';
import { broadcast, messageSessionId, send, sendResult } from './ws-utils.js';

/**
 * Mutable session-scoped state. Handlers always read LIVE values through
 * these getters and write through setters — same closure semantics as
 * the original code captured by direct reference, but reachable through
 * an interface so the route construction can live outside `startWebUI`.
 */
export interface WebuiMutableState {
  getConfig(): Config;
  setConfig(next: Config): void;
  getProjectRoot(): string;
  setProjectRoot(next: string): void;
  getWorkingDir(): string;
  setWorkingDir(next: string): void;
  getSession(): Session;
  setSession(next: Session): void;
  getSessionStartedAt(): number;
  setSessionStartedAt(next: number): void;
  getSessionStore(): SessionStore;
  setSessionStore(next: SessionStore): void;
  getModeId(): string;
  setModeId(next: string): void;
  /** Snapshot of current model capabilities (refreshed on model switch). */
  getModelCapabilities(): unknown;
  getConfigWriteLock(): Promise<void>;
  setConfigWriteLock(next: Promise<void>): void;
  /**
   * Abort and clear any in-flight agent run. Routes shouldn't normally
   * touch runLock directly. The
   * refactor moves that into the projectHandlers setter chain so the
   * route layer just calls a single hook.
   */
  abortRunLock: (sessionId?: string) => void;
  /** True while `sessionId` (or any session, when omitted) owns a run lock. */
  isRunActive: (sessionId?: string) => boolean;
  /** Every session id with an in-flight run — one per busy WebUI tab. */
  getRunningSessionIds: () => string[];
  /**
   * Host-wide serialiser for session transitions. Shared by the session
   * handlers and the conversation ops so run setup never lands on a context
   * that a concurrent session swap is halfway through re-pointing.
   */
  withSessionTransition: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Read-only reference to the live WS clients map. */
  getClients(): Map<WebSocket, ConnectedClient>;
}
/**
 * Services + WS-subsystem handlers, bootstrapped once. Immutable for
 * the duration of a session (the mutable ones live in `WebuiMutableState`).
 */
export interface WebuiDeps {
  trustBoundary: import('@wrongstack/core/security').TrustBoundary;
  agent: Agent;
  getAgent?: ((sessionId?: string) => Agent) | undefined;
  /**
   * The Agent for a session WITHOUT creating one. Read-only callers use this;
   * `getAgent` creates, so asking about a stale id materialises an agent for
   * it and can evict a live tab's.
   */
  peekAgent?: ((sessionId?: string) => Agent | undefined) | undefined;
  hasSession?: ((id: string) => boolean) | undefined;
  /** Does this host already hold an open journal writer for that session? */
  isSessionLive?: ((id: string) => boolean) | undefined;
  context: Context;
  container: Container;
  toolRegistry: ToolRegistry;
  modelsRegistry: ModelsRegistry;
  providerRegistry: ProviderRegistry;
  provider: Provider;
  mcpRegistry: MCPRegistry;
  vault: SecretVault;
  globalConfigPath: string;
  /** Active profile settings config; globalConfigPath is bootstrap metadata only. */
  profileConfigPath: string;
  /** Per-project layout — expose only the bits the route layer touches. */
  wpaths: { globalRoot: string; globalSkills: string; projectSessions: string };
  configStore: ConfigStore;
  tokenCounter: DefaultTokenCounter;
  permissionPolicy: PermissionPolicy;
  pendingConfirms: Map<string, PendingConfirm>;
  pipelines: AgentPipelines;
  logger: Logger;
  memoryStore: MemoryPort;
  modeStore: DefaultModeStore;
  skillLoader: SkillLoader | undefined;
  skillInstaller: SkillInstaller | undefined;
  customModeStore: CustomModeStore;
  compactor: Compactor;
  autoCompactor: AutoCompactionMiddleware | undefined;
  events: EventBus;
  wsHost: string;
  requireToken: boolean;
  publicUrl: string | undefined;
  publicWsUrl: string | undefined;
  wsPort: number;
  httpPort: number;
  wssPrimary: WebSocketServer;
  wssSecondary: WebSocketServer | null;
  /** Per-feature WS handlers (goal, specs, sdd-board, sdd-wizard, …). */
  goalHandler: GoalWebSocketHandler;
  specsHandler: SpecsWebSocketHandler;
  sddBoardHandler: SddBoardWebSocketHandler;
  sddWizardHandler: SddWizardWebSocketHandler;
  worktreeHandler: WorktreeWebSocketHandler;
  collabHandler: CollaborationWebSocketHandler;
  terminalHandler: TerminalWebSocketHandler;
  /** Brain monitoring + last-20 decision log. */
  brain: ObservableBrainArbiter;
  brainSettings: { maxAutoRisk: BrainAutoRisk };
  /** Live-editable Brain config owner (brain.config.get/set). */
  brainRuntime: BrainRuntime;
  brainLog: Array<{ at: number; kind: string; question: string; outcome: string }>;
}

/**
 * Closures the routes call back into `startWebUI` for. These weren't
 * worth lifting into `WebuiMutableState` because they need write access
 * to internals (config persistence, autofill, …) that only the boot
 * context has. The route layer treats them as opaque side-effects and
 * delegates without storing state of its own.
 */
export interface WebuiCallbacks {
  /**
   * Build a `session.start` payload. `overrides.sessionId` selects WHICH
   * session it describes — with four tabs live, the runtime's own "current"
   * session is not necessarily the one being reported on.
   */
  sessionStartPayload: (overrides?: Record<string, unknown>) => Promise<{
    sessionId: string;
    model: string;
    provider: string;
    maxContext: number;
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    projectName: string;
    projectRoot: string;
    cwd: string;
    mode: string;
    contextMode: string;
  }>;
  /** Reserve an explicitly selected session before its writer is opened. */
  claimSession: (sessionId: string, target?: SessionIdentityTarget) => Promise<() => Promise<void>>;
  /** Rebind session-scoped todo persistence before a new todo snapshot is installed. */
  onBeforeSessionTodosReplaced: (sessionId: string, sessionsDir: string) => Promise<void>;
  /** Re-point registry and HQ identity after a writer swap. */
  onSessionSwapped: (sessionId: string, target?: SessionIdentityTarget) => Promise<void>;
  /** Re-build the AutoCompaction middleware denominator on model switch. */
  updateAutoCompactionMaxContext: (
    newProvider: Provider,
    providerId?: string,
    providerCfg?: ProviderConfig | undefined,
  ) => Promise<void>;
  /** Unified, serialized helper for active-profile config mutations. */
  updateGlobalConfig: (
    mutate: (config: Record<string, unknown>) => void,
    errorLabel: string,
  ) => Promise<void>;
  /** Persist the durable subset of context.meta prefs to config.json. */
  persistPrefsToConfig: (payload: Record<string, unknown>) => Promise<void>;
  /** Snapshot of every pref the standalone server exposes. */
  prefSnapshot: () => Record<string, unknown>;
}

export interface AllRoutes {
  providerRoutes: ProviderRouteHandlers;
  sessionRoutes: SessionRouteHandlers;
  projectRoutes: ProjectRouteHandlers;
  modeRoutes: ModeRouteHandlers;
  prefsRoutes: PrefsRouteHandlers;
  autonomyRoutes: AutonomyRouteHandlers;
  shellGitRoutes: ShellGitRouteHandlers;
  mailboxRoutes: MailboxRouteHandlers;
  mcpRoutes: McpRouteHandlers;
  brainRoutes: BrainRouteHandlers;
  goalRoutes: GoalRouteHandlers;
  specsRoutes: SpecsRouteHandlers;
  sddBoardRoutes: SddBoardRouteHandlers;
  sddWizardRoutes: SddWizardRouteHandlers;
}

/**
 * Build the 13 route records referenced by `handleProviderRoute`,
 * `handleSessionRoute`, … `handleSddWizardRoute`. The construction is a
 * direct lift from `startWebUI`; behaviour is unchanged.
 */
export function buildRoutes(
  state: WebuiMutableState,
  deps: WebuiDeps,
  cb: WebuiCallbacks,
): AllRoutes {
  // ---- Provider/Key management helpers (extracted to provider-handlers.ts) ----
  const providerHandlers = createProviderHandlers({
    profileConfigPath: deps.profileConfigPath,
    vault: deps.vault,
    getConfigWriteLock: state.getConfigWriteLock,
    setConfigWriteLock: state.setConfigWriteLock,
    broadcast: (msg) => broadcast(state.getClients(), msg),
    clients: state.getClients(),
    modelsRegistry: deps.modelsRegistry,
    hasActiveModel: () => Boolean(state.getConfig().model),
    onProvidersLoaded: (providers) => {
      state.setConfig(patchConfig(state.getConfig(), { providers }));
    },
    applyModelSwitch: applyModelSwitchCore,
  });

  // Apply a provider+model switch to the live session: sync config, rebuild the
  // provider, refresh the auto-compaction denominator, persist, and broadcast a
  // fresh session.start. Shared by the `model.switch` handler and the
  // adopt-on-first-add path. Throws on provider-construction failure.
  /**
   * Resolve the Context a session-scoped operation should act on. Each WebUI
   * tab owns its own Context (see backend-services' session agent registry);
   * `deps.context` is only the ROOT one, which is a different tab's state as
   * often as not once four sessions are live.
   */
  function sessionContext(sessionId?: string): Context {
    if (!sessionId) return deps.context;
    return deps.getAgent?.(sessionId)?.ctx ?? deps.context;
  }

  async function applyModelSwitchCore(
    newProvider: string,
    newModel: string,
    sessionId?: string,
  ): Promise<void> {
    // Target the requesting tab's context. Without a sessionId (the
    // adopt-first-provider boot path) this is still the root context.
    const targetCtx = sessionContext(sessionId);
    await targetCtx.runModelTransition(async () => {
      const cur = state.getConfig();
      const newCfg = patchConfig(cur, { provider: newProvider, model: newModel });
      const providerCfg: ProviderConfig = newCfg.providers?.[newProvider] ?? { type: newProvider };
      // WrongProxy / WrongTrace: rewrite the switched provider's base URL
      // through the shared helper so the live WebUI session honors the
      // proxy toggle, same as the CLI's `/model` switch path. `newCfg.baseUrl`
      // is the fallback when the saved cfg carries no explicit baseUrl.
      const routedCfg = routeProviderCfgThroughProxy(providerCfg, newCfg.baseUrl, newProvider);
      const built = deps.providerRegistry.has(newProvider)
        ? deps.providerRegistry.create({ ...routedCfg, type: newProvider } as never)
        : makeProviderFromConfig(newProvider, routedCfg);
      // Overlay the target model's catalog facts. A freshly constructed provider
      // only has the wire-family baseline, so without this the session keeps the
      // previous model's context window and loses `maxOutput` entirely.
      const newProv = deps.modelsRegistry
        ? await withCatalogCapabilities(deps.modelsRegistry, newProvider, built, {
            ...routedCfg,
            type: newProvider,
            model: newModel,
          })
        : built;
      // Persist only after the target provider has been constructed. A failed
      // build must leave both the live session and durable selection untouched.
      await cb.updateGlobalConfig((config) => {
        config.provider = newProvider;
        config.model = newModel;
      }, 'model.switch');

      // The global config keeps tracking the most recent choice so it is the
      // default a NEW tab starts from and survives a restart — but the LIVE
      // swap lands only on the session that asked for it.
      state.setConfig(newCfg);
      deps.configStore.update({ provider: newProvider, model: newModel });
      targetCtx.model = newModel;
      targetCtx.provider = newProv;
      // Capability refresh is best-effort after the atomic live swap. A catalog
      // outage must not report the switch as failed after it already committed.
      // Pass the POST-rewrite routedCfg (the same config the provider was built
      // from) so maxContext resolution sees the effective proxy-target URL.
      await cb.updateAutoCompactionMaxContext(newProv, newProvider, routedCfg).catch((error) => {
        deps.logger.warn(`model.switch capability refresh failed: ${String(error)}`);
      });

      broadcast(state.getClients(), {
        type: 'session.start',
        payload: await cb.sessionStartPayload(
          sessionId ? { sessionId, model: newModel, provider: newProvider } : {},
        ),
      });
    });
  }

  const modelOperations = createModelOperations({
    context: deps.context,
    memoryStore: deps.memoryStore,
    modelsRegistry: deps.modelsRegistry,
    getConfig: state.getConfig,
    getLiveProviderId: () => state.getConfig().provider ?? '',
    buildProvider: (providerId, providerConfig) =>
      deps.providerRegistry.has(providerId)
        ? deps.providerRegistry.create({ ...providerConfig, type: providerId } as never)
        : makeProviderFromConfig(providerId, providerConfig),
    applyModelSwitch: applyModelSwitchCore,
    isRunActive: state.isRunActive,
    getSessionContext: (sessionId?: string) => sessionContext(sessionId),
    send,
    broadcast: (message) => broadcast(state.getClients(), message),
    log: (message) => console.warn(message),
  });

  const providerRoutes: ProviderRouteHandlers = {
    providerHandlers,
    listProviders: (ws) => providerHandlers.handleProvidersList(ws),
    listSavedProviders: (ws) => providerHandlers.handleProvidersSaved(ws),
    listProviderModels: (ws, msg) =>
      providerHandlers.handleProviderModels(
        ws,
        (msg as { payload: { providerId: string } }).payload.providerId,
      ),
    searchProviderModels: (ws, query, limit) =>
      providerHandlers.handleProviderModelsSearch(ws, query, limit),
    switchModel: (ws, msg) => modelOperations.switchModel(ws, msg.payload),
    adoptDefaultProviderIfUnset: providerHandlers.adoptDefaultProviderIfUnset,
    refineModel: (ws, msg) =>
      modelOperations.refineModel(
        ws,
        msg.payload as import('./model-operations.js').ModelRefinePayload,
      ),
    fallbackChoice: async (ws, msg) => {
      const result = emitFallbackChoice(deps.events, msg);
      if (!result.ok) {
        send(ws, {
          type: 'error',
          payload: { phase: 'invalid_request', message: result.message },
        });
      }
    },
  };

  const systemPromptAdapter = {
    paths: () => {
      const wpaths = resolveWstackPaths({
        projectRoot: state.getProjectRoot(),
        globalRoot: deps.wpaths.globalRoot,
      });
      return {
        globalDir: wpaths.globalInstructions,
        projectDir: wpaths.inProjectInstructions,
      };
    },
    profileConfigPath: deps.profileConfigPath,
    current: () => state.getConfig().systemPrompt?.variant ?? 'default',
    // Mutate the live Config *before* rebuilding: `persistPrefsToConfig`
    // writes the file, not the in-memory object, and the builder reads the
    // variant off the object. Without this the rebuild would faithfully
    // recompose the prompt the session already had.
    applyVariant: async (variant: string, sessionId?: string) => {
      const config = state.getConfig();
      state.setConfig(
        patchConfig(config, {
          systemPrompt: { ...(config.systemPrompt ?? {}), variant: variant as never },
        }),
      );
      // Rebuild the asking tab's prompt. The container rebind stays global on
      // purpose: it only changes which builder NEW subagents are composed
      // from, which is a default rather than live conversation state.
      const targetCtx = sessionContext(sessionId);
      const modeId =
        typeof targetCtx.meta['modeId'] === 'string' && targetCtx.meta['modeId']
          ? (targetCtx.meta['modeId'] as string)
          : state.getModeId();
      targetCtx.meta['systemPromptVariant'] = variant;
      await rebuildSystemPrompt(
        {
          modeStore: deps.modeStore,
          memoryStore: deps.memoryStore,
          skillLoader: deps.skillLoader,
          modelCapabilities: (() => state.getModelCapabilities()) as never,
          context: targetCtx,
          toolRegistry: deps.toolRegistry,
          getConfig: state.getConfig,
          projectRoot: state.getProjectRoot(),
          globalRoot: deps.wpaths.globalRoot,
          container: deps.container,
        },
        modeId,
      );
    },
  };

  const sessionRoutes: SessionRouteHandlers = createSessionHandlers({
    withSessionTransition: state.withSessionTransition,
    config: state.getConfig(),
    clients: state.getClients(),
    context: deps.context,
    events: deps.events,
    toolRegistry: deps.toolRegistry,
    compactor: deps.compactor,
    customModeStore: deps.customModeStore,
    tokenCounter: deps.tokenCounter,
    getProjectRoot: state.getProjectRoot,
    getSession: state.getSession,
    getSessionStore: state.getSessionStore,
    sessionsDir: deps.wpaths.projectSessions,
    setSession: state.setSession,
    setSessionStartedAt: state.setSessionStartedAt,
    claimSession: cb.claimSession,
    onBeforeSessionTodosReplaced: cb.onBeforeSessionTodosReplaced,
    onSessionSwapped: cb.onSessionSwapped,
    abortActiveRun: state.abortRunLock,
    isRunActive: state.isRunActive,
    getAgent: deps.getAgent,
    hasSession: deps.hasSession,
    isSessionLive: deps.isSessionLive,
    sessionStartPayload: cb.sessionStartPayload,
    systemPrompt: systemPromptAdapter,
  });

  const projectRoutes: ProjectRouteHandlers = createProjectHandlers({
    globalConfigPath: deps.globalConfigPath,
    wpaths: deps.wpaths as never,
    clients: state.getClients(),
    context: deps.context,
    tokenCounter: deps.tokenCounter,
    config: state.getConfig(),
    getConfig: state.getConfig,
    getProjectRoot: state.getProjectRoot,
    getSession: state.getSession,
    setProjectRoot: state.setProjectRoot,
    setWorkingDir: state.setWorkingDir,
    setSession: state.setSession,
    setSessionStore: state.setSessionStore,
    setSessionStartedAt: state.setSessionStartedAt,
    abortRunLock: state.abortRunLock,
    onBeforeSessionTodosReplaced: cb.onBeforeSessionTodosReplaced,
    onSessionSwapped: cb.onSessionSwapped,
    sessionStartPayload: cb.sessionStartPayload,
  });

  const modeRoutes: ModeRouteHandlers = createModeHandlers({
    modeStore: deps.modeStore,
    memoryStore: deps.memoryStore,
    skillLoader: deps.skillLoader,
    modelCapabilities: (() => state.getModelCapabilities()) as never,
    context: deps.context,
    toolRegistry: deps.toolRegistry,
    config: state.getConfig(),
    getConfig: state.getConfig,
    projectRoot: state.getProjectRoot(),
    globalRoot: deps.wpaths.globalRoot,
    clients: state.getClients(),
    setModeId: state.setModeId,
    sessionStartPayload: cb.sessionStartPayload,
    getSessionContext: (sessionId?: string) => sessionContext(sessionId),
  });

  const prefsContext: PrefsHandlerContext = {
    meta: deps.context.meta,
    // Session-scoped prefs (autonomy, yolo, context strategy, prompt variant,
    // reasoning) land on the calling tab's own context meta.
    metaFor: (sessionId?: string) => sessionContext(sessionId).meta,
    // Session-aware: the scoped keys live on that tab's own context meta.
    snapshot: (sessionId?: string) =>
      sessionId ? prefSnapshotImpl(sessionContext(sessionId).meta) : cb.prefSnapshot(),
    persist: cb.persistPrefsToConfig,
    pendingConfirms: deps.pendingConfirms,
    configStore: deps.configStore,
    systemPrompt: systemPromptAdapter,
    setYolo: (enabled) =>
      (deps.permissionPolicy as { setYolo?: (value: boolean) => void }).setYolo?.(enabled),
    applyConfigPrefs: (payload) => {
      const config = state.getConfig();
      const features = (config.features ?? {}) as unknown as Record<string, unknown>;
      if (typeof payload['featureMcp'] === 'boolean') features['mcp'] = payload['featureMcp'];
      if (typeof payload['featurePlugins'] === 'boolean')
        features['plugins'] = payload['featurePlugins'];
      if (typeof payload['featureMemory'] === 'boolean')
        features['memory'] = payload['featureMemory'];
      if (typeof payload['featureSkills'] === 'boolean')
        features['skills'] = payload['featureSkills'];
      if (typeof payload['featureModelsRegistry'] === 'boolean')
        features['modelsRegistry'] = payload['featureModelsRegistry'];
      config.features = features as never;
      if (Array.isArray(payload['fallbackModels']))
        config.fallbackModels = payload['fallbackModels'] as string[];
      if (
        payload['fallbackProfiles'] &&
        typeof payload['fallbackProfiles'] === 'object' &&
        !Array.isArray(payload['fallbackProfiles'])
      ) {
        config.fallbackProfiles = payload['fallbackProfiles'] as Record<string, string[]>;
      }
      if (Array.isArray(payload['favoriteModels']))
        config.favoriteModels = payload['favoriteModels'] as string[];
      if (typeof payload['favoriteModelsOnly'] === 'boolean')
        config.favoriteModelsOnly = payload['favoriteModelsOnly'];
      if (Array.isArray(payload['modelAvailabilitySchedule']))
        config.modelAvailabilitySchedule = payload[
          'modelAvailabilitySchedule'
        ] as import('@wrongstack/core/models').ModelBlackoutRule[];
      if (
        payload['modelMatrix'] &&
        typeof payload['modelMatrix'] === 'object' &&
        !Array.isArray(payload['modelMatrix'])
      ) {
        config.modelMatrix = payload['modelMatrix'] as NonNullable<typeof config.modelMatrix>;
      }
      if (typeof payload['fallbackAuto'] === 'boolean')
        config.fallbackAuto = payload['fallbackAuto'];
    },
    // WrongProxy / WrongTrace: reflect the standalone toggle/URL into the
    // shared `ProxyConfig` singleton immediately and await the re-probe so
    // `active` is fresh before a subsequent model.switch reads it. In the
    // CLI-hosted path this same key is the CLI's `applyWrongProxyPrefs`; when
    // running as its own process there is no CLI to inject it, so route it to
    // the server-local runtime module.
    applyWrongProxyPrefs: (payload) => applyWrongProxyPrefsRuntime(payload),
    setAutoCompact: (enabled) => {
      // Keep the middleware INSTALLED and let it decide per conversation.
      // Adding and removing it on the shared pipeline was a process-wide
      // switch driven by a per-tab preference: turning auto-compaction off in
      // one tab stopped it for the three running beside it, and turning it
      // back on re-armed it for all of them.
      if (!deps.autoCompactor) return;
      if (!deps.pipelines.contextWindow.list().includes('AutoCompaction')) {
        deps.pipelines.contextWindow.use({
          name: 'AutoCompaction',
          handler: deps.autoCompactor.handler(),
        });
      }
      deps.autoCompactor.setEnabled(enabled);
    },
    setLogLevel: (level) => {
      (deps.logger as { level: string }).level = level;
    },
    send,
    broadcast: (message) => broadcast(state.getClients(), message),
  };
  const doctorConfigHandler = (ws: WebSocket, apply: boolean) =>
    handleConfigDoctor(ws, apply, {
      profileConfigPath: deps.profileConfigPath,
      vault: deps.vault,
      updateConfig: cb.updateGlobalConfig,
      applyRuntimeConfig: (next) => {
        state.setConfig(next);
        deps.configStore.update(next);
      },
    });
  const prefsRoutes = createPrefsRouteHandlers(prefsContext, doctorConfigHandler);
  const autonomyRoutes = createAutonomyRouteHandlers(prefsContext);

  const shellGitRoutes: ShellGitRouteHandlers = {
    gitInfo: async (ws) => {
      await handleGitInfo(ws, state.getProjectRoot());
    },
    gitChanges: async (ws) => {
      await handleGitChanges(ws, state.getProjectRoot());
    },
    gitDiff: async (ws, msg) => {
      const parsed = validateGitDiffPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      await handleGitDiff(ws, state.getProjectRoot(), parsed.value.path);
    },
    gitStage: async (ws, msg) => {
      const parsed = validateGitStagePayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      await handleGitStage(ws, state.getProjectRoot(), parsed.value.paths);
    },
    gitUnstage: async (ws, msg) => {
      const parsed = validateGitUnstagePayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      await handleGitUnstage(ws, state.getProjectRoot(), parsed.value.paths);
    },
    gitDiscard: async (ws, msg) => {
      const parsed = validateGitDiscardPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      await handleGitDiscard(ws, state.getProjectRoot(), parsed.value.paths);
    },
    gitCommit: async (ws, msg) => {
      const parsed = validateGitCommitPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      await handleGitCommit(ws, state.getProjectRoot(), parsed.value.message);
    },
    shellOpen: async (ws, msg) => {
      const parsed = validateShellOpenPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      // Normalize the wire-format target ('file'|'terminal') to the
      // handler contract ('terminal'|'file-manager').
      const normalizedTarget: ShellOpenTarget = normalizeShellOpenTarget(parsed.value.target);
      const authorization = await authorizeWebUIAction(
        deps.trustBoundary,
        {
          capability: normalizedTarget === 'terminal' ? 'process.spawn' : 'filesystem.open-native',
          subject: {
            kind: 'path',
            id: parsed.value.path,
            attributes: { target: normalizedTarget },
          },
          risk: 'elevated',
          cwd: state.getProjectRoot(),
          metadata: { transport: 'websocket' },
        },
        deps.logger,
      );
      if (!authorization.allowed) {
        sendResult(ws, false, `Shell action denied: ${authorization.reason}`);
        return;
      }
      const result: ShellOpenResult = await handleShellOpen(
        { path: parsed.value.path, target: normalizedTarget },
        deps.logger,
        { projectRoot: state.getProjectRoot() },
      );
      sendResult(ws, result.success, result.message);
    },
  };

  const mailboxRoutes = createMailboxRouteHandlers({
    getProjectRoot: state.getProjectRoot,
    getGlobalRoot: () => path.dirname(deps.globalConfigPath),
    events: deps.events,
  });

  // ---- MCP route (handleMcpRoute) ----
  // Issue #31 follow-on (after #118 PR 0 baseline, #119 prefs extraction).
  // Each callback delegates to the matching handleMcpXxx in mcp-handlers.ts
  // — that module already owns the WS-message logic, this is just the
  // chain-of-responsibility wiring. The 10 cases were pure delegations
  // inside the residual switch before this PR; now they're an explicit
  // sibling in the chain.
  const mcpRoutes: McpRouteHandlers = {
    list: (ws, msg) => handleMcpList(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    // add/update are the spawn-capable pair — they take a `command`/`args`
    // from the wire and start it. They go past the trust boundary (M1).
    add: (ws, msg) =>
      handleMcpAdd(ws, msg, deps.profileConfigPath, deps.mcpRegistry, deps.trustBoundary),
    update: (ws, msg) =>
      handleMcpUpdate(ws, msg, deps.profileConfigPath, deps.mcpRegistry, deps.trustBoundary),
    remove: (ws, msg) => handleMcpRemove(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    enable: (ws, msg) => handleMcpEnable(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    disable: (ws, msg) => handleMcpDisable(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    sleep: (ws, msg) => handleMcpSleep(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    wake: (ws, msg) => handleMcpWake(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    restart: (ws, msg) => handleMcpRestart(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    discover: (ws, msg) => handleMcpDiscover(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    resources: (ws, msg) => handleMcpResources(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    prompts: (ws, msg) => handleMcpPrompts(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    resourceRead: (ws, msg) =>
      handleMcpResourceRead(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
    promptGet: (ws, msg) => handleMcpPromptGet(ws, msg, deps.profileConfigPath, deps.mcpRegistry),
  };

  const brainContext: BrainHandlerContext = {
    send,
    brainSettings: deps.brainSettings,
    brainRuntime: deps.brainRuntime,
    getBrainLog: () => deps.brainLog,
    resolveArbiter: () => deps.brain,
    getSessionId: () => deps.context.session?.id,
  };
  const brainRoutes: BrainRouteHandlers = {
    status: (ws, msg) => handleBrainStatus(brainContext, ws, messageSessionId(msg)),
    risk: (ws, msg) =>
      handleBrainRisk(
        brainContext,
        ws,
        (msg.payload as { level?: string } | undefined)?.level ?? '',
      ),
    ask: (ws, msg) =>
      handleBrainAsk(
        brainContext,
        ws,
        (msg.payload as { question?: string } | undefined)?.question,
      ),
    configGet: (ws) => handleBrainConfigGet(brainContext, ws),
    configSet: (ws, msg) => handleBrainConfigSet(brainContext, ws, msg.payload),
  };

  const goalRoutes: GoalRouteHandlers = {
    handleMessage: (ws, msg) => deps.goalHandler.handleMessage(ws, msg),
  };

  const specsRoutes: SpecsRouteHandlers = {
    handleMessage: (msg) => deps.specsHandler.handleMessage(msg),
  };

  const sddBoardRoutes: SddBoardRouteHandlers = {
    handleMessage: (msg) => deps.sddBoardHandler.handleMessage(msg),
  };

  const sddWizardRoutes: SddWizardRouteHandlers = {
    handleMessage: (msg) => deps.sddWizardHandler.handleMessage(msg),
  };

  return {
    providerRoutes,
    sessionRoutes,
    projectRoutes,
    modeRoutes,
    prefsRoutes,
    autonomyRoutes,
    shellGitRoutes,
    mailboxRoutes,
    mcpRoutes,
    brainRoutes,
    goalRoutes,
    specsRoutes,
    sddBoardRoutes,
    sddWizardRoutes,
  };
}
