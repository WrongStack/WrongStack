/**
 * Route contexts assembly for embedded message router.
 *
 * @module webui-server/route-contexts
 */

import * as path from 'node:path';
import type { Agent } from '@wrongstack/core/agent';
import { TOKENS } from '@wrongstack/core/kernel';
import { SkillInstaller } from '@wrongstack/core/skills';
import { PromptUsageStore } from '@wrongstack/core/storage';
import type { SessionWriter } from '@wrongstack/core/types';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import {
  type BrainHandlerContext,
  type CustomModeStore,
  createMailboxRouteHandlers,
  type DesignContext,
  type EmbeddedAgentConfigContext,
  type EmbeddedConversationContext,
  type EmbeddedProjectContext,
  type EmbeddedSessionContext,
  type IntrospectionRouteContext,
  type PendingConfirm,
  type PrefsHandlerContext,
  type PromptsContext,
  rebuildSystemPrompt,
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
  buildSessionStartPayload: (
    overrides?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  /** Preference snapshot for one tab's meta; the leader's when none is named. */
  prefSnapshot: (meta?: Record<string, unknown> | undefined) => Record<string, unknown>;
  persistPrefs: (patch: Record<string, unknown>) => Promise<void>;
  pendingConfirms: Map<string, PendingConfirm>;
  abortControllers: Map<string, AbortController>;
  /**
   * The Agent that owns one session's runs — one per open tab.
   *
   * Handing every tab the single leader Agent is what made a second tab answer
   * with "Agent.run() is already in progress on this instance": the guard is
   * right, one instance for four tabs was not.
   */
  getSessionAgent: (sessionId?: string | undefined) => Agent;
  /**
   * Non-creating registry peek. Feeds the embedded host's `hasSession`
   * ownership check so asking "can this host serve session X?" never
   * materializes an agent (the creating `getSessionAgent` did).
   */
  peekSessionAgent?: (sessionId?: string | undefined) => Agent | undefined;
  /** Does the host already hold an open writer for that session? */
  isSessionLive: (sessionId: string) => boolean;
  /**
   * The host's foreground-session pointer. Kept OUT of the leader agent's
   * context: that context is the boot tab's runtime, and using it as the
   * pointer made every resume re-point the boot tab.
   */
  getForegroundSession: () => SessionWriter;
  setForegroundSession: (next: SessionWriter) => void;
  /** Live connections, so `session.subscribe` has somewhere to land. */
  clients: Map<WebSocket, { sessionId: string | null; sessionIds?: Set<string> | undefined }>;
  /** Retire the per-tab agents of sessions nobody is displaying any more. */
  onSessionsUndisplayed: (sessionIds: string[]) => void;
  /** Stop the subagents one session spawned, when that session is aborted. */
  stopSessionFleet?: ((sessionId: string) => void | Promise<void>) | undefined;
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
  getSessionAgent,
  peekSessionAgent,
  isSessionLive,
  getForegroundSession,
  setForegroundSession,
  clients,
  onSessionsUndisplayed,
  stopSessionFleet,
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

  /**
   * The Design Studio kit is a conversation-level choice — it rides the
   * system prompt and changes what the agent writes. Pinned on the leader it
   * re-styled whichever tab happened to boot the process, so it is resolved
   * against the tab that picked it.
   */
  const designCtx = (sessionId?: string | undefined): DesignContext => ({
    projectRoot: skillsProjectRoot,
    agentMeta: (sessionId ? getSessionAgent(sessionId)?.ctx : undefined) ?? opts.agent.ctx,
  });

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

  const promptProjectRoot = (): string =>
    opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string | undefined }).projectRoot ?? '';

  /**
   * The meta bag of one tab.
   *
   * Session-scoped preferences are written to, and read from, the session's
   * own context. This host used to hand the prefs handlers only the leader's
   * meta, so every tab's autonomy / yolo / reasoning / context-strategy write
   * landed on the leader and every read answered from it — the per-session
   * preference work never applied to the host people actually run.
   */
  const metaForSession = (sessionId?: string | undefined): Record<string, unknown> =>
    (sessionId ? getSessionAgent(sessionId)?.ctx.meta : undefined) ?? opts.agent.ctx.meta;

  const prefsCtx: PrefsHandlerContext = {
    meta: opts.agent.ctx.meta,
    metaFor: metaForSession,
    snapshot: (sessionId) => prefSnapshot(sessionId ? metaForSession(sessionId) : undefined),
    persist: persistPrefs,
    setYolo: opts.onYoloSwitch,
    setAutonomy: opts.onAutonomySwitch,
    applyWrongProxyPrefs: opts.onWrongProxyPrefsChange,
    pendingConfirms,
    configStore: opts.agent.container?.safeResolve?.(TOKENS.ConfigStore),
    systemPrompt: {
      paths: () => {
        const wpaths = resolveWstackPaths({ projectRoot: promptProjectRoot(), globalRoot });
        return {
          globalDir: wpaths.globalInstructions,
          projectDir: wpaths.inProjectInstructions,
        };
      },
      profileConfigPath,
      current: () => opts.appConfig?.systemPrompt?.variant ?? 'default',
      // Patch the live config before rebuilding — `persistPrefs` writes the
      // file, and the builder reads the variant off the in-memory object.
      applyVariant: async (variant, sessionId) => {
        if (opts.appConfig) {
          opts.appConfig = {
            ...opts.appConfig,
            systemPrompt: { ...(opts.appConfig.systemPrompt ?? {}), variant },
          };
        }
        const tools = opts.agent.tools as
          | import('@wrongstack/core/registry').ToolRegistry
          | undefined;
        if (!tools || !opts.appConfig) return;
        // Rebuild the prompt of the tab that asked. This used to rebuild the
        // LEADER's — the boot tab's runtime — so picking a lighter identity in
        // one tab quietly rewrote the system prompt of the conversation in
        // another. The variant is a per-session preference; the config write
        // above is only the default a new tab inherits.
        const targetCtx = sessionId ? getSessionAgent(sessionId).ctx : opts.agent.ctx;
        targetCtx.meta['systemPromptVariant'] = variant;
        await rebuildSystemPrompt(
          {
            modeStore: opts.modeStore,
            memoryStore: opts.memoryStore,
            skillLoader: opts.skillLoader,
            modelCapabilities: {
              maxContextTokens: opts.agent.ctx.provider?.capabilities?.maxContext,
              supportsTools: !!opts.agent.ctx.provider?.capabilities?.tools,
              supportsVision: !!opts.agent.ctx.provider?.capabilities?.vision,
              supportsReasoning: !!opts.agent.ctx.provider?.capabilities?.reasoning,
            },
            context: targetCtx,
            toolRegistry: tools,
            getConfig: () => opts.appConfig as NonNullable<typeof opts.appConfig>,
            projectRoot: promptProjectRoot(),
            globalRoot,
            container: opts.agent.container,
          },
          typeof targetCtx.meta['mode'] === 'string'
            ? (targetCtx.meta['mode'] as string)
            : 'default',
        );
      },
    },
    send,
    broadcast,
  };

  const projectsCtx: EmbeddedProjectContext = {
    opts,
    getForegroundSession,
    setForegroundSession,
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
    // Session transitions must re-point the TARGET session's context, not the
    // leader's — resuming tab 2 was rewriting the context tab 1 ran in.
    getAgent: getSessionAgent,
    // Non-creating peek for the hasSession ownership gate.
    ...(peekSessionAgent ? { peekAgent: peekSessionAgent } : {}),
    // Session-keyed, so "is this tab running" is answered per tab and not
    // "is anything running in this process".
    isRunActive: (sessionId) =>
      sessionId ? abortControllers.has(sessionId) : abortControllers.size > 0,
    isSessionLive,
    getForegroundSession,
    setForegroundSession,
    clients,
    onSessionsUndisplayed,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  const connectionCtx: EmbeddedConversationContext = {
    agent: opts.agent,
    getAgent: getSessionAgent,
    // Non-creating peek for the hasSession ownership gate (background-tab
    // requests are legitimate; arbitrary strings are not).
    ...(peekSessionAgent ? { peekAgent: peekSessionAgent } : {}),
    abortControllers,
    pendingConfirms,
    ...(stopSessionFleet ? { stopSessionFleet } : {}),
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
