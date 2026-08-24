/**
 * Route contexts assembly for embedded message router.
 *
 * @module webui-server/route-contexts
 */

import * as path from 'node:path';
import { TOKENS } from '@wrongstack/core/kernel';
import { SkillInstaller } from '@wrongstack/core/skills';
import { PromptUsageStore } from '@wrongstack/core/storage';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import {
  type BrainHandlerContext,
  createMailboxRouteHandlers,
  type CustomModeStore,
  type DesignContext,
  type EmbeddedAgentConfigContext,
  type EmbeddedConversationContext,
  type EmbeddedProjectContext,
  type EmbeddedSessionContext,
  type IntrospectionRouteContext,
  type PendingConfirm,
  type PrefsHandlerContext,
  type PromptsContext,
  type SkillsContext,
} from '@wrongstack/webui-server';
import type { WebSocket } from 'ws';
import type { CliWebUIOptions } from '../webui-server-options.js';
import type { WSServerMessage } from './contracts.js';
import { loadSavedProviders } from './provider-config.js';

export interface RouteContextsParams {
  opts: CliWebUIOptions;
  profileConfigPath: string;
  profileDir: string;
  globalRoot: string;
  sessionStartedAt: number;
  currentSessionId: () => string;
  getCustomModeStore: () => Promise<CustomModeStore>;
  buildSessionStartPayload: (overrides?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  prefSnapshot: () => Record<string, unknown>;
  persistPrefs: (patch: Record<string, unknown>) => Promise<void>;
  pendingConfirms: Map<string, PendingConfirm>;
  abortControllers: Map<string, AbortController>;
  getAbortController: () => AbortController | null;
  clearAbortController: () => void;
  send: (ws: WebSocket, msg: WSServerMessage) => void;
  broadcast: (msg: WSServerMessage) => void;
}

export function createWebuiRouteContexts({
  opts,
  profileConfigPath,
  profileDir,
  globalRoot,
  sessionStartedAt,
  currentSessionId,
  getCustomModeStore,
  buildSessionStartPayload,
  prefSnapshot,
  persistPrefs,
  pendingConfirms,
  abortControllers,
  getAbortController,
  clearAbortController,
  send,
  broadcast,
}: RouteContextsParams) {
  const brainCtx: BrainHandlerContext = {
    brainSettings: opts.brainSettings,
    brainRuntime: opts.brainRuntime,
    getBrainLog: opts.getBrainLog,
    resolveArbiter: () =>
      opts.brain ??
      (opts.agent.container.has(TOKENS.BrainArbiter)
        ? opts.agent.container.resolve(TOKENS.BrainArbiter)
        : undefined),
    getSessionId: currentSessionId,
    send,
  };

  const introspectionConfigStore = opts.agent.container?.safeResolve?.(TOKENS.ConfigStore);
  const introspectionCtx: IntrospectionRouteContext = {
    agent: opts.agent,
    modelsRegistry: opts.modelsRegistry,
    configStore: introspectionConfigStore,
    getConfig: () => {
      const cfg = introspectionConfigStore?.get() ?? opts.appConfig;
      if (!cfg)
        throw new Error(
          'Introspection route requires a config but neither ConfigStore nor opts.appConfig is available',
        );
      return cfg;
    },
    getProjectRoot: () =>
      opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '',
    getSessionId: currentSessionId,
    getSessionStartedAt: () => sessionStartedAt,
    getModeId: () => opts.modeId ?? 'default',
    send,
  };

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
          manifestPath: path.join(skillsPaths?.configDir ?? profileDir, 'installed-skills.json'),
          projectSkillsDir:
            skillsPaths?.inProjectSkills ?? path.join(skillsProjectRoot, '.wrongstack', 'skills'),
          globalSkillsDir: skillsPaths?.globalSkills ?? path.join(profileDir, 'skills'),
          projectHash: skillsPaths?.projectHash ?? '',
          skillLoader: opts.skillLoader,
        })
      : undefined,
    projectRoot: skillsProjectRoot,
    projectSkillsDir: skillsPaths?.inProjectSkills,
    globalSkillsDir: skillsPaths?.globalSkills,
  };

  const promptsCtx: PromptsContext = {
    promptLoader: opts.promptLoader,
    promptUsage: new PromptUsageStore(
      skillsPaths?.promptUsage ?? path.join(profileDir, 'prompt-usage.json'),
    ),
  };

  const designCtx: DesignContext = {
    projectRoot: skillsProjectRoot,
    agentMeta: opts.agent.ctx,
  };

  const agentConfigCtx: EmbeddedAgentConfigContext = {
    agent: opts.agent,
    modeStore: opts.modeStore,
    loadSavedProviders: () => loadSavedProviders(profileConfigPath),
    buildSessionStart: (overrides) => buildSessionStartPayload(overrides),
    modelsRegistry: opts.modelsRegistry,
    memoryStore: opts.memoryStore,
    getConfig: () => opts.appConfig,
    onMaxContextResolved: opts.onModelContextResolved,
    persistPrefs,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  const prefsCtx: PrefsHandlerContext = {
    meta: opts.agent.ctx.meta,
    snapshot: prefSnapshot,
    persist: persistPrefs,
    setYolo: opts.onYoloSwitch,
    setAutonomy: opts.onAutonomySwitch,
    applyWrongProxyPrefs: opts.onWrongProxyPrefsChange,
    pendingConfirms,
    configStore: opts.agent.container?.safeResolve?.(TOKENS.ConfigStore),
    send,
    broadcast,
  };

  const projectsCtx: EmbeddedProjectContext = {
    opts,
    abortControllers,
    abortLegacyRun: () => {
      const controller = getAbortController();
      if (controller) {
        controller.abort();
        clearAbortController();
      }
    },
    buildSessionStart: (overrides) => buildSessionStartPayload(overrides),
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  const mailboxRoutes = createMailboxRouteHandlers({
    getProjectRoot: () =>
      opts.projectRoot ??
      (opts.agent.ctx as { projectRoot?: string | undefined }).projectRoot ??
      '',
    getGlobalRoot: () => (opts.globalConfigPath ? path.dirname(opts.globalConfigPath) : ''),
    events: opts.events,
  });

  const sessionsCtx: EmbeddedSessionContext = {
    opts,
    buildSessionStart: (overrides) => buildSessionStartPayload(overrides),
    getCustomModeStore,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  const connectionCtx: EmbeddedConversationContext = {
    agent: opts.agent,
    abortControllers,
    pendingConfirms,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  return {
    brainCtx,
    introspectionCtx,
    skillsCtx,
    promptsCtx,
    designCtx,
    agentConfigCtx,
    prefsCtx,
    projectsCtx,
    mailboxRoutes,
    sessionsCtx,
    connectionCtx,
  };
}
