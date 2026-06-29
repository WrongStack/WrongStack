/**
 * WebUI route-table construction.
 *
 * Phase 1a of the god-module split (issue: God-modules >1500 lines).
 * `startWebUI` in `./index.ts` previously inlined the construction of
 * 13 `*Routes` records (provider / session / project / mode / prefs /
 * shell-git / mailbox / mcp / brain / autophase / specs / sdd-board /
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

import type { WebSocket, WebSocketServer } from 'ws';

import type {
  Agent,
  AgentPipelines,
  Context,
  DefaultMemoryStore,
  DefaultModeStore,
  EventBus,
  ModelsRegistry,
  ObservableBrainArbiter,
  PermissionPolicy,
  Provider,
  ProviderConfig,
  ProviderRegistry,
  SkillInstaller,
  SkillLoader,
  ToolRegistry,
} from '@wrongstack/core';
import {
  enhanceUserPrompt,
  gatedEnhancerReasoning,
  recentTextTurns,
  resolveProviderModelList,
} from '@wrongstack/core';
import type {
  AutoCompactionMiddleware,
  BrainArbiter,
  BrainAutoRisk,
  Compactor,
  ConfigStore,
  DefaultTokenCounter,
  Logger,
  SecretVault,
  TokenCounter,
} from '@wrongstack/core';
import type { SessionStore } from '@wrongstack/core';
type Session = Awaited<ReturnType<SessionStore['create']>>;
import type { Config } from '@wrongstack/core/types';
import { MCPRegistry } from '@wrongstack/mcp';
import { makeProviderFromConfig } from '@wrongstack/providers';

import {
  handleGitChanges,
  handleGitDiff,
  handleGitInfo,
} from './git-handlers.js';
import { handleShellOpen, type ShellOpenRequest, type ShellOpenResult } from './shell-open.js';
import {
  handleMailboxAgents,
  handleMailboxClear,
  handleMailboxMessages,
  handleMailboxPurge,
} from './mailbox-handlers.js';
import {
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
} from './mcp-handlers.js';
import {
  validateBrainAskPayload,
  validateBrainRiskPayload,
  validateGitDiffPayload,
  validateMailboxAgentsPayload,
  validateMailboxMessagesPayload,
  validateMailboxPurgePayload,
  validateModelSwitchPayload,
  validatePrefsUpdatePayload,
  validateShellOpenPayload,
} from './ws-payload-validation.js';
import { AutoPhaseWebSocketHandler } from './autophase-ws-handler.js';
import { SpecsWebSocketHandler } from './specs-ws-handler.js';
import { SddBoardWebSocketHandler } from './sdd-board-ws-handler.js';
import { SddWizardWebSocketHandler } from './sdd-wizard-ws-handler.js';
import { WorktreeWebSocketHandler } from './worktree-ws-handler.js';
import { CollaborationWebSocketHandler } from './collaboration-ws-handler.js';
import { TerminalWebSocketHandler } from './terminal-ws-handler.js';
import { broadcast, errMessage, send, sendResult } from './ws-utils.js';
import { computeUsageCost, getCostRates } from './usage-cost.js';
import { createProviderHandlers, projectSavedProviders } from './provider-handlers.js';
import { createModeHandlers } from './mode-handlers.js';
import { createProjectHandlers } from './project-handlers.js';
import { createSessionHandlers } from './session-handlers.js';
import type { ProviderRouteHandlers } from './provider-routes.js';
import type { SessionRouteHandlers } from './session-routes.js';
import type { ProjectRouteHandlers } from './project-routes.js';
import type { ModeRouteHandlers } from './mode-routes.js';
import type { PrefsRouteHandlers } from './prefs-routes.js';
import type { ShellGitRouteHandlers } from './shell-git-routes.js';
import type { MailboxRouteHandlers } from './mailbox-routes.js';
import type { McpRouteHandlers } from './mcp-routes.js';
import type { BrainRouteHandlers } from './brain-routes.js';
import type { AutoPhaseRouteHandlers } from './autophase-routes.js';
import type { SpecsRouteHandlers } from './specs-routes.js';
import type { SddBoardRouteHandlers } from './sdd-board-routes.js';
import type { SddWizardRouteHandlers } from './sdd-wizard-routes.js';

import { patchConfig } from './boot.js';
import type { ConnectedClient } from './types.js';
import type { CustomModeStore } from './custom-context-modes.js';

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
   * touch runLock directly — `projects.select` is the main caller. The
   * refactor moves that into the projectHandlers setter chain so the
   * route layer just calls a single hook.
   */
  abortRunLock: () => void;
  /** Read-only reference to the live WS clients map. */
  getClients(): Map<WebSocket, ConnectedClient>;
}

/**
 * Services + WS-subsystem handlers, bootstrapped once. Immutable for
 * the duration of a session (the mutable ones live in `WebuiMutableState`).
 */
export interface WebuiDeps {
  agent: Agent;
  context: Context;
  container: import('@wrongstack/core').Container;
  toolRegistry: ToolRegistry;
  modelsRegistry: ModelsRegistry;
  providerRegistry: ProviderRegistry;
  provider: Provider;
  mcpRegistry: MCPRegistry;
  vault: SecretVault;
  globalConfigPath: string;
  /** Per-project layout — expose only the bits the route layer touches. */
  wpaths: { globalRoot: string };
  configStore: ConfigStore;
  tokenCounter: DefaultTokenCounter;
  permissionPolicy: PermissionPolicy;
  pipelines: AgentPipelines;
  logger: Logger;
  memoryStore: DefaultMemoryStore;
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
  /** Per-feature WS handlers (autophase, specs, sdd-board, sdd-wizard, …). */
  autoPhaseHandler: AutoPhaseWebSocketHandler;
  specsHandler: SpecsWebSocketHandler;
  sddBoardHandler: SddBoardWebSocketHandler;
  sddWizardHandler: SddWizardWebSocketHandler;
  worktreeHandler: WorktreeWebSocketHandler;
  collabHandler: CollaborationWebSocketHandler;
  terminalHandler: TerminalWebSocketHandler;
  /** Brain monitoring + last-20 decision log. */
  brain: ObservableBrainArbiter;
  brainSettings: { maxAutoRisk: BrainAutoRisk };
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
  sessionStartPayload: () => Promise<{
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
  /** Re-build the AutoCompaction middleware denominator on model switch. */
  updateAutoCompactionMaxContext: (newProvider: Provider) => Promise<void>;
  /** Unified, serialized, decrypt→mutate→encrypt→write helper for globalConfigPath. */
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
  shellGitRoutes: ShellGitRouteHandlers;
  mailboxRoutes: MailboxRouteHandlers;
  mcpRoutes: McpRouteHandlers;
  brainRoutes: BrainRouteHandlers;
  autoPhaseRoutes: AutoPhaseRouteHandlers;
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
    globalConfigPath: deps.globalConfigPath,
    vault: deps.vault,
    getConfigWriteLock: state.getConfigWriteLock,
    setConfigWriteLock: state.setConfigWriteLock,
    broadcast: (msg) => broadcast(state.getClients(), msg),
    clients: state.getClients(),
    modelsRegistry: deps.modelsRegistry,
  });

  const providerRoutes: ProviderRouteHandlers = {
    providerHandlers,
    listProviders: async (ws) => {
      const providers = await deps.modelsRegistry.listProviders();
      // "Configured" should mean *any* working credential, not just env vars.
      // Users register keys with `wstack auth`, which writes apiKey/apiKeys
      // into config.providers[<id>] — those are decrypted in memory here.
      const savedIds = new Set(Object.keys(state.getConfig().providers ?? {}));
      send(ws, {
        type: 'provider.catalog',
        payload: {
          providers: providers.map((p: { id: string; name: string; family: unknown; apiBase?: unknown; envVars: string[]; models: readonly unknown[] }) => ({
            id: p.id,
            name: p.name,
            family: p.family,
            apiBase: p.apiBase,
            envVars: p.envVars,
            modelCount: p.models.length,
            hasApiKey: savedIds.has(p.id) || p.envVars.some((v: string) => !!process.env[v]),
          })),
        },
      });
    },
    listSavedProviders: async (ws) => {
      const saved = await providerHandlers.loadConfigProviders();
      send(ws, {
        type: 'providers.saved',
        payload: { providers: projectSavedProviders(saved) },
      });
    },
    listProviderModels: async (ws, msg) => {
      const providerId = (msg as { payload: { providerId: string } }).payload.providerId;
      // Merge catalog + saved config so OAuth / subscription providers
      // (github-copilot, anthropic-oauth, openai-codex, …) that models.dev
      // doesn't list still resolve to their saved model allowlist. Always
      // reply (possibly empty) — the switcher lazy-loads every saved provider.
      const saved = await providerHandlers.loadConfigProviders();
      const cfg = saved[providerId];
      const catalogId = cfg?.type && cfg.type !== providerId ? cfg.type : providerId;
      const provider = await deps.modelsRegistry.getProvider(catalogId);
      send(ws, {
        type: 'provider.models',
        payload: {
          provider: providerId,
          models: resolveProviderModelList(cfg?.models, provider),
        },
      });
    },
    switchModel: async (ws, msg) => {
      const parsed = validateModelSwitchPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      const { provider: newProvider, model: newModel } = parsed.value;
      try {
        // Update config
        const cur = state.getConfig();
        state.setConfig(patchConfig(cur, { provider: newProvider, model: newModel }));
        deps.configStore.update({ provider: newProvider, model: newModel });
        deps.context.model = newModel;

        // Create new provider instance — fail loudly if the user picks a
        // provider with no creds rather than silently keeping the old one.
        const newCfg = state.getConfig();
        const providerCfg: ProviderConfig = newCfg.providers?.[newProvider] ?? { type: newProvider };
        const newProv = deps.providerRegistry.has(newProvider)
          ? deps.providerRegistry.create({ ...providerCfg, type: newProvider } as never)
          : makeProviderFromConfig(newProvider, providerCfg);
        deps.context.provider = newProv;

        // Update AutoCompactionMiddleware with the new model's maxContext so
        // backend threshold triggers (warn/soft/hard) use the correct denominator.
        // sessionStartPayload is called below (after this block) and uses
        // the new provider for its modelsRegistry lookup.
        await cb.updateAutoCompactionMaxContext(newProv);

        // Persist to global config file via the unified config mutation helper.
        await cb.updateGlobalConfig((config) => {
          config.provider = newProvider;
          config.model = newModel;
        }, 'model.switch');

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
        return;
      }

      broadcast(state.getClients(), {
        type: 'session.start',
        payload: await cb.sessionStartPayload(),
      });
    },
    refineModel: async (ws, msg) => {
      const { text } = (msg as { payload: { text: string } }).payload;
      if (!text?.trim()) {
        send(ws, {
          type: 'model.refine_result',
          payload: { refined: '', english: '', error: 'Empty text' },
        });
        return;
      }
      try {
        const history = recentTextTurns(deps.context.messages);
        // Gate a low-effort reasoning hint to the active model's capabilities
        // (config is patched live on model.switch). Refinement is a shallow
        // rewrite, so this trims wasted thinking on reasoning models; resolves
        // to undefined → no reasoning field, as before.
        const cfg = state.getConfig();
        const resolved = await deps.modelsRegistry
          .getModel(cfg.provider ?? '', cfg.model ?? '')
          .catch(() => undefined);
        const reasoning = gatedEnhancerReasoning(resolved?.capabilities?.reasoningConfig as never);
        const result = await enhanceUserPrompt({
          provider: deps.context.provider,
          model: deps.context.model,
          text,
          history,
          timeoutMs: 90000,
          ...(reasoning ? { reasoning } : {}),
          onError: (reason: unknown) => {
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
    },
  };

  const sessionRoutes: SessionRouteHandlers = createSessionHandlers({
    config: state.getConfig(),
    clients: state.getClients(),
    context: deps.context,
    toolRegistry: deps.toolRegistry,
    compactor: deps.compactor,
    customModeStore: deps.customModeStore,
    tokenCounter: deps.tokenCounter,
    getProjectRoot: state.getProjectRoot,
    getSession: state.getSession,
    getSessionStore: state.getSessionStore,
    setSession: state.setSession,
    setSessionStartedAt: state.setSessionStartedAt,
    sessionStartPayload: cb.sessionStartPayload,
  });

  const projectRoutes: ProjectRouteHandlers = createProjectHandlers({
    globalConfigPath: deps.globalConfigPath,
    wpaths: deps.wpaths as never,
    clients: state.getClients(),
    context: deps.context,
    modeStore: deps.modeStore,
    memoryStore: deps.memoryStore,
    skillLoader: deps.skillLoader,
    modelCapabilities: (() => state.getModelCapabilities()) as never,
    toolRegistry: deps.toolRegistry,
    tokenCounter: deps.tokenCounter,
    config: state.getConfig(),
    getModeId: state.getModeId,
    getProjectRoot: state.getProjectRoot,
    getSession: state.getSession,
    setProjectRoot: state.setProjectRoot,
    setWorkingDir: state.setWorkingDir,
    setSession: state.setSession,
    setSessionStore: state.setSessionStore,
    setSessionStartedAt: state.setSessionStartedAt,
    abortRunLock: state.abortRunLock,
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
    projectRoot: state.getProjectRoot(),
    globalRoot: deps.wpaths.globalRoot,
    clients: state.getClients(),
    setModeId: state.setModeId,
    sessionStartPayload: cb.sessionStartPayload,
  });

  const prefsRoutes: PrefsRouteHandlers = {
    getPrefs: async (ws) => {
      // Return the current pref snapshot so a freshly-connected client
      // can seed its local-prefs store from the server's truth.
      send(ws, { type: 'prefs.updated', payload: cb.prefSnapshot() });
    },
    updatePrefs: async (ws, msgPayload) => {
      // Batch preference update from the webui. Merges arbitrary key/value
      // pairs into context.meta so the runtime can read them immediately,
      // broadcasts the full pref snapshot to every connected client so all
      // browser tabs stay in sync, and persists the durable keys to
      // config.json (same keys the TUI settings picker writes).
      const parsed = validatePrefsUpdatePayload(msgPayload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      const payload = parsed.value.prefs;
      // Write each pref into context.meta
      for (const [key, val] of Object.entries(payload)) {
        deps.context.meta[key] = val;
      }
      void cb.persistPrefsToConfig(payload);
      // YOLO mode: toggle the permission policy so tool confirmations
      // are auto-approved instead of prompting the user. Uses the live
      // reference resolved from the container at startup.
      if (typeof payload['yolo'] === 'boolean') {
        (deps.permissionPolicy as { setYolo?: (v: boolean) => void }).setYolo?.(payload['yolo']);
      }
      // Also update config.features for feature flags that affect tool/skill
      // initialisation (these were read at startup but can be changed at runtime
      // by the agent's permission middleware or tool guards).
      const cfg = state.getConfig();
      const features = (cfg.features ?? {}) as unknown as Record<string, unknown>;
      if (typeof payload['featureMcp'] === 'boolean') features['mcp'] = payload['featureMcp'];
      if (typeof payload['featurePlugins'] === 'boolean') features['plugins'] = payload['featurePlugins'];
      if (typeof payload['featureMemory'] === 'boolean') features['memory'] = payload['featureMemory'];
      if (typeof payload['featureSkills'] === 'boolean') features['skills'] = payload['featureSkills'];
      if (typeof payload['featureModelsRegistry'] === 'boolean') features['modelsRegistry'] = payload['featureModelsRegistry'];
      cfg.features = features as never;

      // Global fallback chain: mutate the live config so the leader's fallback
      // extension (which reads config each turn) honours it without a restart.
      if (Array.isArray(payload['fallbackModels'])) cfg.fallbackModels = payload['fallbackModels'] as string[];
      if (
        payload['fallbackProfiles'] &&
        typeof payload['fallbackProfiles'] === 'object' &&
        !Array.isArray(payload['fallbackProfiles'])
      ) {
        cfg.fallbackProfiles = payload['fallbackProfiles'] as Record<string, string[]>;
      }
      if (Array.isArray(payload['favoriteModels'])) cfg.favoriteModels = payload['favoriteModels'] as string[];
      if (typeof payload['favoriteModelsOnly'] === 'boolean') cfg.favoriteModelsOnly = payload['favoriteModelsOnly'];
      if (
        payload['modelMatrix'] &&
        typeof payload['modelMatrix'] === 'object' &&
        !Array.isArray(payload['modelMatrix'])
      ) {
        cfg.modelMatrix = payload['modelMatrix'] as typeof cfg.modelMatrix;
      }
      if (typeof payload['fallbackAuto'] === 'boolean') cfg.fallbackAuto = payload['fallbackAuto'];

      // Runtime effects: apply prefs that change server behaviour immediately.

      // contextAutoCompact — toggle AutoCompactionMiddleware in/out of the
      // contextWindow pipeline. When off, the pipeline skips the compaction
      // step entirely (zero overhead). When on, re-adds the middleware.
      if (typeof payload['contextAutoCompact'] === 'boolean') {
        if (payload['contextAutoCompact'] && deps.autoCompactor) {
          // Re-add: remove first (idempotent via optional), then insert.
          deps.pipelines.contextWindow.remove('AutoCompaction', { optional: true });
          deps.pipelines.contextWindow.use({ name: 'AutoCompaction', handler: deps.autoCompactor.handler() });
        } else {
          deps.pipelines.contextWindow.remove('AutoCompaction', { optional: true });
        }
      }

      // logLevel — the DefaultLogger.level property is a public mutable
      // field. Setting it at runtime changes the log threshold immediately
      // (the log() method checks LEVEL_RANK on every call).
      if (typeof payload['logLevel'] === 'string') {
        const valid = ['debug', 'info', 'warn', 'error'] as const;
        if ((valid as readonly string[]).includes(payload['logLevel'])) {
          (deps.logger as { level: string }).level = payload['logLevel'] as typeof valid[number];
        }
      }

      // auditLevel — stored in context.meta by the generic loop above.
      // Consumed by the session audit log system at session-close time.

      // Broadcast the full current prefs snapshot to ALL clients.
      broadcast(state.getClients(), { type: 'prefs.updated', payload: cb.prefSnapshot() });
    },
  };

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
    shellOpen: async (ws, msg) => {
      const parsed = validateShellOpenPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      const result: ShellOpenResult = await handleShellOpen(parsed.value as ShellOpenRequest, deps.logger);
      sendResult(ws, result.success, result.message);
    },
  };

  const mailboxRoutes: MailboxRouteHandlers = {
    messages: (ws, msg) => {
      const parsed = validateMailboxMessagesPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      return handleMailboxMessages(
        ws,
        { projectRoot: state.getProjectRoot(), globalRoot: path.dirname(deps.globalConfigPath) },
        parsed.value,
      );
    },
    agents: (ws, msg) => {
      const parsed = validateMailboxAgentsPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      return handleMailboxAgents(
        ws,
        { projectRoot: state.getProjectRoot(), globalRoot: path.dirname(deps.globalConfigPath) },
        parsed.value,
      );
    },
    clear: (ws) =>
      handleMailboxClear(
        ws,
        { projectRoot: state.getProjectRoot(), globalRoot: path.dirname(deps.globalConfigPath) },
      ),
    purge: (ws, msg) => {
      const parsed = validateMailboxPurgePayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      return handleMailboxPurge(
        ws,
        { projectRoot: state.getProjectRoot(), globalRoot: path.dirname(deps.globalConfigPath) },
        parsed.value,
      );
    },
  };

  // ---- MCP route (handleMcpRoute) ----
  // Issue #31 follow-on (after #118 PR 0 baseline, #119 prefs extraction).
  // Each callback delegates to the matching handleMcpXxx in mcp-handlers.ts
  // — that module already owns the WS-message logic, this is just the
  // chain-of-responsibility wiring. The 10 cases were pure delegations
  // inside the residual switch before this PR; now they're an explicit
  // sibling in the chain.
  const mcpRoutes: McpRouteHandlers = {
    list: (ws, msg) => handleMcpList(ws, msg, deps.globalConfigPath, deps.mcpRegistry),
    add: (ws, msg) => handleMcpAdd(ws, msg, deps.globalConfigPath, deps.mcpRegistry),
    update: (ws, msg) => handleMcpUpdate(ws, msg, deps.globalConfigPath, deps.mcpRegistry),
    remove: (ws, msg) => handleMcpRemove(ws, msg, deps.globalConfigPath, deps.mcpRegistry),
    enable: (ws, msg) => handleMcpEnable(ws, msg, deps.globalConfigPath, deps.mcpRegistry),
    disable: (ws, msg) => handleMcpDisable(ws, msg, deps.globalConfigPath, deps.mcpRegistry),
    sleep: (ws, msg) => handleMcpSleep(ws, msg, deps.globalConfigPath, deps.mcpRegistry),
    wake: (ws, msg) => handleMcpWake(ws, msg, deps.globalConfigPath, deps.mcpRegistry),
    restart: (ws, msg) => handleMcpRestart(ws, msg, deps.globalConfigPath, deps.mcpRegistry),
    discover: (ws, msg) => handleMcpDiscover(ws, msg, deps.globalConfigPath, deps.mcpRegistry),
  };

  const brainRoutes: BrainRouteHandlers = {
    status: (ws) => {
      send(ws, {
        type: 'brain.status',
        payload: { maxAutoRisk: deps.brainSettings.maxAutoRisk, log: deps.brainLog },
      });
    },
    risk: (ws, msg) => {
      const parsed = validateBrainRiskPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      const { level } = parsed.value;
      deps.brainSettings.maxAutoRisk = level as BrainAutoRisk;
      send(ws, {
        type: 'brain.status',
        payload: { maxAutoRisk: deps.brainSettings.maxAutoRisk, log: deps.brainLog },
      });
    },
    ask: async (ws, msg) => {
      const parsed = validateBrainAskPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      const { question } = parsed.value;
      try {
        const decision = await deps.brain.decide({
          id: `brain-ask-${Date.now().toString(36)}`,
          sessionId: deps.context.session?.id,
          source: 'user',
          question,
          risk: 'medium',
          fallback: 'ask_human',
        });
        send(ws, { type: 'brain.answer', payload: { sessionId: deps.context.session?.id, question, decision } });
      } catch (err) {
        sendResult(ws, false, `Brain consultation failed: ${errMessage(err)}`);
      }
    },
  };

  const autoPhaseRoutes: AutoPhaseRouteHandlers = {
    handleMessage: (msg) => deps.autoPhaseHandler.handleMessage(msg),
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
    shellGitRoutes,
    mailboxRoutes,
    mcpRoutes,
    brainRoutes,
    autoPhaseRoutes,
    specsRoutes,
    sddBoardRoutes,
    sddWizardRoutes,
  };
}
