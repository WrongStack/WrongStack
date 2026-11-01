import { handleJevRoute } from './jev-routes.js';
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
import { TOKENS } from '@wrongstack/contracts/kernel';
import type { SessionEvent } from '@wrongstack/contracts/types';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { makeProviderFromConfig } from '@wrongstack/providers';
import { patchConfig } from './boot.js';
import type { BrainHandlerContext } from './brain-handlers.js';
import { type BrainRouteHandlers, createBrainRouteHandlers } from './brain-routes.js';
import { type ChimeraRouteHandlers, createChimeraRouteHandlers } from './chimera-routes.js';
import {
  type CodeAssistRouteHandlers,
  createCodeAssistRouteHandlers,
} from './code-assist-routes.js';
import { emitFallbackChoice } from './fallback-choice.js';
import { handleFallbackSuggest } from './fallback-suggest-handler.js';
import type { GoalRouteHandlers } from './goal-routes.js';
import { createMailboxRouteHandlers } from './mailbox-routes.js';
import { createMcpRouteTable } from './mcp-route-table.js';
import type { McpRouteHandlers } from './mcp-routes.js';
import { createModeHandlers } from './mode-handlers.js';
import type { ModeRouteHandlers } from './mode-routes.js';
import { createModelOperations } from './model-operations.js';
import { createApplyModelSwitch, createSessionContextResolver } from './model-switch-core.js';
import { resolvePendingConfirmsForSession } from './pending-confirms.js';
import { createPrefsAndAutonomyRoutes } from './prefs-route-context.js';
import { createProjectHandlers } from './project-handlers.js';
import type { ProjectRouteHandlers } from './project-routes.js';
import { createProviderHandlers } from './provider-handlers.js';
import type { ProviderRouteHandlers } from './provider-routes.js';
import { createProviderStatusPersistence } from './provider-status-persistence.js';
import type { AllRoutes, WebuiCallbacks, WebuiDeps, WebuiMutableState } from './route-contracts.js';
import type { SddBoardRouteHandlers } from './sdd-board-routes.js';
import type { SddWizardRouteHandlers } from './sdd-wizard-routes.js';
import { createSessionHandlers } from './session-handlers.js';
import type { SessionRouteHandlers } from './session-routes.js';
import { createShellGitRoutes } from './shell-git-route-table.js';
import type { ShellGitRouteHandlers } from './shell-git-routes.js';
import type { SpecsRouteHandlers } from './specs-routes.js';
import { createSystemPromptRouteAdapter } from './system-prompt-route-adapter.js';
import { broadcast, send } from './ws-utils.js';

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
  // Session-context resolution + the live provider/model switch live in
  // ./model-switch-core.ts; both are shared by several route records below.
  const sessionContext = createSessionContextResolver(deps);
  const applyModelSwitchCore = createApplyModelSwitch(state, deps, cb, sessionContext);

  // ---- Provider/Key management helpers (extracted to provider-handlers.ts) ----
  const providerHandlers = createProviderHandlers({
    profileConfigPath: deps.profileConfigPath,
    vault: deps.vault,
    getConfigWriteLock: state.getConfigWriteLock,
    setConfigWriteLock: state.setConfigWriteLock,
    broadcast: (msg) => broadcast(state.getClients(), msg),
    clients: state.getClients(),
    modelsRegistry: deps.modelsRegistry,
    getDisabledModels: () => state.getConfig().disabledModels ?? [],
    getDisabledProviders: () => state.getConfig().disabledProviders ?? [],
    hasActiveModel: () => Boolean(state.getConfig().model),
    onProvidersLoaded: (providers) => {
      state.setConfig(patchConfig(state.getConfig(), { providers }));
    },
    applyModelSwitch: applyModelSwitchCore,
  });
  const modelOperations = createModelOperations({
    context: deps.context,
    memoryStore: deps.memoryStore,
    modelsRegistry: deps.modelsRegistry,
    getConfig: state.getConfig,
    getLiveProviderId: () => state.getConfig().provider ?? '',
    buildProvider: (providerId, providerConfig) => {
      const factoryType = providerConfig.type ?? providerId;
      return deps.providerRegistry.has(factoryType)
        ? deps.providerRegistry.create(
            { ...providerConfig, type: providerId } as never,
            factoryType,
          )
        : makeProviderFromConfig(providerId, { ...providerConfig, type: factoryType });
    },
    applyModelSwitch: applyModelSwitchCore,
    isRunActive: state.isRunActive,
    getSessionContext: (sessionId?: string) => sessionContext(sessionId),
    send,
    broadcast: (message) => broadcast(state.getClients(), message),
    log: (message) => console.warn(message),
  });

  const statusTracker = deps.container.safeResolve(TOKENS.ProviderModelStatusTracker);
  const statusPersistence = statusTracker
    ? createProviderStatusPersistence(statusTracker, deps.profileConfigPath)
    : undefined;
  const providerRoutes: ProviderRouteHandlers = {
    statusTracker,
    ...(statusPersistence
      ? {
          prepareProviderStatus: statusPersistence.prepare,
          persistProviderStatusControl: statusPersistence.persistControl,
          providerAuditFile: statusPersistence.auditFile,
        }
      : {}),
    providerHandlers,
    listProviders: (ws) => providerHandlers.handleProvidersList(ws),
    listSavedProviders: (ws) => providerHandlers.handleProvidersSaved(ws),
    listProviderModels: (ws, msg) =>
      providerHandlers.handleProviderModels(
        ws,
        (msg as { payload: { providerId: string } }).payload.providerId,
        {
          includeDisabled:
            (msg as { payload: { includeDisabled?: boolean | undefined } }).payload
              .includeDisabled === true,
        },
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
    suggestFallbacks: (ws, msg) =>
      handleFallbackSuggest(ws, msg.payload, {
        collectCandidates: providerHandlers.collectFallbackCandidates,
        resolveLlm: (sessionId) => {
          const ctx = sessionContext(sessionId);
          return { provider: ctx.provider, model: ctx.model };
        },
        send,
      }),
  };
  const systemPromptAdapter = createSystemPromptRouteAdapter(state, deps, sessionContext);

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
    // A new tab's Context is cloned from the leader's; this re-points it at
    // the configured default so the record and the runtime agree.
    applyModelSwitch: applyModelSwitchCore,
    getAgent: deps.getAgent,
    ...(deps.peekAgent ? { peekAgent: deps.peekAgent } : {}),
    hasSession: deps.hasSession,
    isSessionLive: deps.isSessionLive,
    // Releases background-delegation results held while nobody showed the session.
    ...(deps.autoWake
      ? { onSessionsDisplayed: (ids: string[]) => deps.autoWake?.onSessionsDisplayed(ids) }
      : {}),
    // A resumed session gets back the delegation results it never received.
    rehydrateDelegations: (sessionId, events) => {
      deps.container
        .safeResolve(TOKENS.DelegationTracker)
        ?.rehydrate(sessionId, events as readonly SessionEvent[]);
    },
    // A permission prompt raised in a tab that has since closed is
    // unanswerable: it was parked on that tab's lane, and the lane is gone.
    // Left pending it wedges `agent.run` forever, and a run that never settles
    // never releases its lock — the session then refuses to be stopped OR
    // deleted. The blanket drain in connection-lifecycle only fires when the
    // LAST socket goes away, which never happens while the other tabs are
    // open, so the per-session drain has to run here.
    onSessionsUndisplayed: (sessionIds: string[]) => {
      for (const sessionId of sessionIds) {
        const orphaned = resolvePendingConfirmsForSession(deps.pendingConfirms, sessionId);
        if (orphaned === 0) continue;
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'webui.confirm_orphaned_by_tab_close',
            sessionId,
            count: orphaned,
            message: `Denied ${orphaned} unanswerable permission prompt(s) for closed session ${sessionId}.`,
          }),
        );
      }
    },
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
  const { prefsRoutes, autonomyRoutes } = createPrefsAndAutonomyRoutes(
    state,
    deps,
    cb,
    sessionContext,
    systemPromptAdapter,
  );

  const shellGitRoutes: ShellGitRouteHandlers = createShellGitRoutes(state, deps);

  const mailboxRoutes = createMailboxRouteHandlers({
    getProjectRoot: state.getProjectRoot,
    getGlobalRoot: () => path.dirname(deps.globalConfigPath),
    events: deps.events,
  });

  const chimeraRoutes: ChimeraRouteHandlers = createChimeraRouteHandlers({
    // Same layout resolution the systemPromptAdapter uses below: projectDir is
    // the per-project WrongStack home (~/.wrongstack/projects/<slug>) where the
    // CLI persists review-reports.jsonl. Read lazily — project switches re-root.
    projectDir: () =>
      resolveWstackPaths({
        projectRoot: state.getProjectRoot(),
        globalRoot: deps.wpaths.globalRoot,
      }).projectDir,
    send,
    log: (message) => deps.logger.warn(message),
  });

  // Code Assist ("Ask AI" panel on File Manager / Code Atlas). Each run is a
  // throwaway isolated agent, so this never creates or swaps a session and
  // never appears in the user's session list.
  const codeAssistRoutes: CodeAssistRouteHandlers = createCodeAssistRouteHandlers({
    subagentFactory: deps.subagentFactory,
    projectRoot: () => state.getProjectRoot(),
    send,
    log: (message) => deps.logger.warn(message),
  });
  // ---- MCP route (handleMcpRoute) ---- delegations live in ./mcp-route-table.ts.
  const mcpRoutes: McpRouteHandlers = createMcpRouteTable(deps, state.isRunActive);

  const brainContext: BrainHandlerContext = {
    send,
    brainSettings: deps.brainSettings,
    brainRuntime: deps.brainRuntime,
    getBrainLog: () => deps.brainLog,
    resolveArbiter: () => deps.brain,
    getSessionId: () => deps.context.session?.id,
  };
  const brainRoutes: BrainRouteHandlers = createBrainRouteHandlers(brainContext);
  brainRoutes.jev = (ws, msg) =>
    handleJevRoute(
      { store: deps.configStore, file: deps.profileConfigPath, vault: deps.vault, send },
      ws,
      msg,
    );

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
    chimeraRoutes,
    codeAssistRoutes,
    mailboxRoutes,
    mcpRoutes,
    brainRoutes,
    goalRoutes,
    specsRoutes,
    sddBoardRoutes,
    sddWizardRoutes,
  };
}
export { computeConfigPrefUpdates } from './config-pref-updates.js';
export type { AllRoutes, WebuiCallbacks, WebuiDeps, WebuiMutableState } from './route-contracts.js';
