import { normalizeTokenSavingTier } from '@wrongstack/contracts/types';
import { setQueuedMessagesSnapshot } from '@wrongstack/core/agent';
import { type CoordinatorEvent, LeaderAutoWakeController } from '@wrongstack/core/coordination';
import { activeLeaderEffort } from '@wrongstack/core/execution';
import { noOpVault } from '@wrongstack/core/security';
import { attachTodosCheckpoint, QueueStore } from '@wrongstack/core/storage';
import { sessionScopedPath } from '@wrongstack/core/utils';
import type { createToolVisionAdapters } from '@wrongstack/runtime/vision';
import { confirmAcpLeaderThroughEvents } from './acp-leader/acp-leader-host.js';
import { runTuiDispatch } from './boot/dispatch-tui.js';
import { createTuiCoordinatorCallbacks } from './boot/tui-coordinator-callbacks.js';
import { setupAutonomousCoordinator } from './boot/tui-coordinator-setup.js';
import {
  registerDebugStreamCallback,
  restoreDebugStreamCallback,
} from './boot/tui-debug-stream.js';
import { wireGoal } from './boot/tui-goal-wiring.js';
import { getLiveSessions, onSwitchToSession } from './boot/tui-live-sessions.js';
import {
  getProjectPickerItems,
  onProjectSelect,
  type ProjectPickerContext,
} from './boot/tui-project-picker-callback.js';
import { handleProjectSwitchSpawn } from './boot/tui-project-spawn.js';
import {
  type ProjectSwitchContext,
  switchProjectInPlace as switchProjectInPlaceExtracted,
} from './boot/tui-project-switch.js';
import type { TuiRuntimeState } from './boot/tui-runtime-state.js';
import {
  getSDDContext as getSDDContextExtracted,
  onSDDOutput as onSDDOutputExtracted,
} from './boot/tui-sdd-callback.js';
import { createSettingsAdapter } from './boot/tui-settings-adapter.js';
import { createThemeAdapter } from './boot/tui-theme-adapter.js';
import { type WorktreeRef, withWorktreeSwitch } from './boot/worktree-sessions.js';
import { createBrainPanelHost } from './brain-menu/panel-service.js';
import type { ExecuteDeps } from './execute-deps.js';
import { createExecutionSessionCallbacks } from './execution-session-callbacks.js';
import { createTuiNextStepCallbacks } from './execution-tui-next-step-callbacks.js';
import { resolveActiveApiKey } from './provider-config-utils.js';
import type { StandaloneAutoUpdate } from './standalone-auto-update.js';
import { createSubagentModelsPanelHost } from './subagent-models/panel-service.js';
import { createTuiResourceMenuGetter } from './tui-resource-menus.js';
import { createTuiResumeCallback } from './tui-resume-callback.js';
import type { UpdateInfo } from './update-check.js';
import { CLI_VERSION } from './version.js';

/** Locals `execute` computes before branching, plus the coordinator-stop setter. */
export interface ExecutionTuiLocals {
  wpaths: ExecuteDeps['core']['wpaths'];
  projectRoot: ExecuteDeps['core']['projectRoot'];
  activeSessionStore: ExecuteDeps['session']['sessionStore'];
  detachActiveTodosCheckpoint: (() => void | Promise<void>) | undefined;
  profileName: string;
  bootUpdateInfo: UpdateInfo | undefined;
  supportsVision: () => Promise<boolean>;
  visionAdapters: () => ReturnType<typeof createToolVisionAdapters>;
  goalFlag: string | undefined;
  askFlag: string | undefined;
  autoUpdate: StandaloneAutoUpdate | undefined;
  setCoordinatorStop: (fn: (() => void) | undefined) => void;
}

/**
 * The interactive TUI branch of `execute`: wire the TUI runtime state,
 * project-switch and coordinator plumbing, then run the TUI until it exits.
 * `exitWith` carries a project-switch child's exit code when one replaced
 * this session.
 */
export async function runExecutionTui(
  deps: ExecuteDeps,
  local: ExecutionTuiLocals,
): Promise<{ code: number; exitWith?: number }> {
  const {
    core: {
      agent,
      events,
      config,
      configStore,
      vault,
      flags,
      slashRegistry,
      tokenCounter,
      sessionRef,
      activateSessionIdentity,
    },
    session: {
      session,
      context,
      attachments,
      queueStore,
      mailbox,
      memoryStore,
      modeStore,
      restoredMessages,
      restoredToolCalls,
      restoredEvents,
    },
    provider: {
      savedProviderCfg,
      resolvedProvider,
      statusTracker,
      getPickableProviders,
      switchProviderAndModel,
    },
    ui: { renderer, secretInputController, effectiveMaxContext, skillLoader, modeId },
    fleet: {
      director,
      getDirector,
      coordinatorController,
      fleetRoster,
      fleetStreamController,
      agentsMonitorController,
      agentTranscripts,
      authHost,
      onPanelOpen,
    },
    controllers: {
      interruptController,
      enhanceController,
      getEnhancerReasoning,
      getActiveModelReasoningEffortLevels,
      buildEnhancerProvider,
      getEnhanceFallbackRef,
      getConfiguredRefinerRef,
      statuslineHiddenItems,
      setStatuslineHiddenItems,
      saveStatuslineHiddenItems,
      statuslineLines,
      setStatuslineLines,
      saveStatuslineLines,
      statuslineDensities,
      setStatuslineDensities,
      saveStatuslineDensities,
      statuslineOrder,
      setStatuslineOrder,
      saveStatuslineOrder,
      getYolo,
      onYolo,
      getAutonomy,
      onAutonomy,
      getNextPredict,
      applyLiveSettings,
    },
    picker: {
      getPluginItems,
      onPluginToggle,
      getMcpServers,
      onMcpToggle,
      onMcpRestart,
      onMcpManage,
      getToolsItems,
      onToolToggle,
      getBrainData,
      onBrainRiskLevel,
      brain,
      brainRuntime,
      getShadowData,
      onShadowStart,
      onShadowStop,
    } = {},
    lifecycles: {
      getSuggestions,
      getEternalEngine,
      getParallelEngine,
      getSddRun,
      onSddLifecycle,
      subscribeEternalIteration,
      subscribeEternalStage,
    } = {},
  } = deps;
  const {
    wpaths,
    projectRoot,
    activeSessionStore,
    detachActiveTodosCheckpoint,
    profileName,
    bootUpdateInfo,
    supportsVision,
    visionAdapters,
    goalFlag,
    askFlag,
    autoUpdate,
  } = local;
  let code = 0;
  agent.disableInteractiveConfirmation();
  confirmAcpLeaderThroughEvents();

  const state: TuiRuntimeState = {
    projectRoot,
    wpaths,
    activeSessionStore,
    activateSessionIdentity,
    detachActiveTodosCheckpoint,
    // Plumbed from cli-main.ts so `resumeSession` can repoint the ref
    // when an in-process `/resume` swaps the active writer. Optional
    // on TuiRuntimeState; tests/hosts that omit it revert to the
    // pre-refactor behavior where provider calls stay pinned to the
    // boot session.
    sessionRef,
    pendingProjectSwitch: null,
    autonomousCoordinator: null,
    coordinatorRun: null,
    coordinatorEvents: new Set(),
  };

  const banneredFamily = savedProviderCfg?.family ?? resolvedProvider?.family;
  const banneredKey =
    (savedProviderCfg ? resolveActiveApiKey(savedProviderCfg) : undefined) ??
    config.apiKey ??
    (resolvedProvider?.envVars ?? savedProviderCfg?.envVars ?? [])
      .map((v) => process.env[v])
      .find((v): v is string => !!v);
  const banneredKeyTail =
    banneredKey && banneredKey.length >= 3 ? banneredKey.slice(-3) : undefined;

  const goalWiring = wireGoal(events);
  const subscribeGoal = goalWiring.subscribe;
  const coordinatorEvents = new Set<(event: CoordinatorEvent) => void>();
  state.coordinatorEvents = coordinatorEvents;
  const autonomousCoordinationEnabled = config.features.autonomousCoordination !== false;
  const coordinatorSetup = autonomousCoordinationEnabled
    ? setupAutonomousCoordinator({
        state,
        events,
        context,
        brain,
        wpaths,
        mailbox,
        director,
        getDirector,
        coordinatorController,
        onCoordinatorStopSetter: (fn) => {
          local.setCoordinatorStop(fn ?? undefined);
        },
      })
    : {
        ensure: () => null,
        cleanup: () => undefined,
      };
  const ensureAutonomousCoordinator = coordinatorSetup.ensure;
  const offDirectorSpawned = coordinatorSetup.cleanup;

  const switchCtx: ProjectSwitchContext = {
    state,
    context,
    events,
    agent,
    config,
    tokenCounter,
    modeId,
    modeStore,
    memoryStore,
    skillLoader,
    attachTodosCheckpoint,
  };
  const switchProjectInPlace = async (targetRoot: string, displayName: string) => {
    return switchProjectInPlaceExtracted(switchCtx, targetRoot, displayName);
  };
  // Sessions of other git worktrees in the last /resume listing.
  const worktreeSessions = new Map<string, WorktreeRef>();

  const pickerCtx: ProjectPickerContext = {
    state,
    renderer,
    director,
    getEternalEngine,
    getParallelEngine,
    switchCtx,
    switchProjectInPlace,
  };

  // Background-delegation auto-wake (TUI only — one-shot/print modes exit
  // and never wake). Config is read live from the user config; `fleet` is
  // denied in project config, so a repo cannot enable autonomous wakes.
  const leaderAutoWake = new LeaderAutoWakeController({
    events,
    config: () => {
      try {
        return configStore.get()?.fleet?.delegate;
      } catch {
        return undefined;
      }
    },
  });
  renderer.setTuiActive(true);
  try {
    code = await runTuiDispatch({
      leaderAutoWake,
      agent,
      // The session store's root. Without it /rewind, the checkpoint
      // timeline and /rewind redo resolve every session file against ''
      // and fail, and the layout store and history archive stay ephemeral.
      sessionsDir: wpaths.projectSessions,
      events,
      slashRegistry,
      skillLoader,
      getResourceMenu: createTuiResourceMenuGetter({
        configStore,
        paths: wpaths,
        memoryStore,
        statusTracker,
        projectRoot,
      }),
      secretInputController,
      attachments,
      tokenCounter,
      visionAdapters,
      supportsVision,
      model: context.model,
      banner: !flags['no-banner'],
      queueStore,
      // `/resume` brings the resumed session's queue along; the WebUI
      // keeps a session's queue in the same file.
      queueStoreFor: (sessionId: string) => {
        try {
          return new QueueStore({
            dir: sessionScopedPath(state.wpaths.projectSessions, sessionId, ''),
          });
        } catch {
          return undefined;
        }
      },
      onQueueChange: (items: string[]) => {
        setQueuedMessagesSnapshot(context, items);
      },
      mouse: flags.mouse ? true : undefined,
      yolo: !!config.yolo,
      getYolo,
      onYolo,
      getAutonomy,
      ...createTuiNextStepCallbacks({
        context,
        getNextPredict,
        getAutonomy,
        getSuggestions,
      }),
      getEternalEngine,
      getSddRun,
      onSddLifecycle,
      subscribeEternalIteration,
      subscribeEternalStage,
      subscribeGoal,
      appVersion: CLI_VERSION,
      latestVersion: bootUpdateInfo?.latest,
      updateAvailable: bootUpdateInfo?.outdated,
      subscribeUpdateReady: autoUpdate?.subscribe,
      provider: config.provider,
      family: banneredFamily,
      keyTail: banneredKeyTail,
      profile: profileName,
      profileConfigPath: (() => {
        const abs = wpaths.profileConfig(profileName);
        const home = wpaths.homeDir;
        return home && abs.startsWith(home) ? `~${abs.slice(home.length)}` : abs;
      })(),
      getPickableProviders,
      switchProviderAndModel,
      switchAutonomy: (mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => {
        onAutonomy?.(mode);
        return null;
      },
      ...createSettingsAdapter({
        configStore,
        wpaths,
        vault: vault ?? noOpVault,
        fleetStreamController,
        applyLiveSettings,
      }),
      ...createThemeAdapter({ configStore, wpaths }),
      getLeaderEffort: () =>
        activeLeaderEffort(context.meta, configStore.get().modelRuntime?.reasoning?.effort),
      configStore,
      effectiveMaxContext,
      titleAnimation:
        ((config.autonomy as Record<string, unknown> | undefined)?.[
          'terminalTitleAnimation'
        ] as boolean) ?? true,
      chime:
        ((config.autonomy as Record<string, unknown> | undefined)?.['chime'] as boolean) ?? false,
      confirmExit:
        ((config.autonomy as Record<string, unknown> | undefined)?.['confirmExit'] as boolean) ??
        true,
      director,
      getDirector,
      fleetRoster,
      ...createTuiCoordinatorCallbacks({
        state,
        context,
        coordinatorEvents,
        ensureAutonomousCoordinator,
      }),
      onClearHistory: (
        dispatch: (
          action:
            | {
                type: 'clearHistory';
                model?: string | undefined;
                provider?: string | undefined;
                /**
                 * Explicit `null` tells the reducer the boot-time restored
                 * transcript source has been discarded by `/clear`. The
                 * reducer resets `historyBudget`, `autoProceedHold`, and
                 * `nextId` to the fresh-boot values when all three are
                 * `null`; omitting them preserves the existing
                 * resume-derived behavior used by `session.rewound` /
                 * `project.switched`.
                 */
                restoredMessages?: readonly unknown[] | null | undefined;
                restoredToolCalls?: readonly unknown[] | null | undefined;
                restoredEvents?: readonly unknown[] | null | undefined;
              }
            | { type: 'resetContextChip' }
            | { type: 'streamReset' }
            | { type: 'toolStreamClear' },
        ) => void,
      ) => {
        void attachments.clear().catch(() => {});
        // `/clear` from the slash command lands here. Pass the three
        // boot-resume sources as explicit `null` so the reducer also
        // resets `historyBudget`, `autoProceedHold`, and `nextId` —
        // otherwise the boot-time restored transcript (set by
        // `wstack --resume <id>`) leaks back into the fresh session.
        dispatch({
          type: 'clearHistory',
          model: context.model,
          provider: context.provider.id,
          restoredMessages: null,
          restoredToolCalls: null,
          restoredEvents: null,
        });
        dispatch({ type: 'resetContextChip' });
        dispatch({ type: 'streamReset' });
        dispatch({ type: 'toolStreamClear' });
      },
      fleetStreamController,
      interruptController,
      enhanceController,
      getEnhancerReasoning,
      getActiveModelReasoningEffortLevels,
      buildEnhancerProvider,
      getEnhanceFallbackRef,
      getConfiguredRefinerRef,
      statuslineHiddenItems,
      setStatuslineHiddenItems,
      saveStatuslineHiddenItems,
      statuslineLines,
      setStatuslineLines,
      saveStatuslineLines,
      statuslineDensities,
      setStatuslineDensities,
      saveStatuslineDensities,
      statuslineOrder,
      setStatuslineOrder,
      saveStatuslineOrder,
      getPluginItems,
      onPluginToggle,
      getMcpServers,
      onMcpToggle,
      onMcpRestart,
      onMcpManage,
      getToolsItems,
      onToolToggle,
      getBrainData,
      onBrainRiskLevel,
      brainPanelHost: brainRuntime ? createBrainPanelHost({ brainRuntime }) : undefined,
      subagentModelsHost: createSubagentModelsPanelHost({
        getContext: () => agent.ctx,
        getSessionTarget: () => ({ provider: config.provider, model: config.model }),
      }),
      getShadowData,
      onShadowStart,
      onShadowStop,
      authHost,
      agentsMonitorController,
      agentTranscripts,
      getLiveSessions: () => getLiveSessions({ state }),
      onSwitchToSession: (_sessionId: string, targetRoot: string, projectName: string) =>
        onSwitchToSession({ state }, _sessionId, targetRoot, projectName),
      initialGoal: goalFlag,
      initialAsk: askFlag,
      projectRoot,
      appConfig: config,
      hqTelemetryOwnedExternally: true,
      getSessionId: () => agent.ctx.session?.id ?? session.id,
      getSDDContext: () => getSDDContextExtracted(),
      onSDDOutput: (output: string) => onSDDOutputExtracted(output),
      modeLabel: modeId,
      getModeLabel: () => {
        const metaMode = context.meta?.['mode'];
        return typeof metaMode === 'string' ? metaMode : (modeId ?? 'default');
      },
      getModes: modeStore
        ? async () => {
            const [modes, active] = await Promise.all([
              modeStore.listModes(),
              modeStore.getActiveMode(),
            ]);
            return { modes, activeId: active?.id ?? null };
          }
        : undefined,
      switchMode: modeStore
        ? async (id: string) => {
            const prev = await modeStore.getActiveMode();
            await modeStore.setActiveMode(id);
            const active = await modeStore.getActiveMode();
            const from = prev?.id ?? 'default';
            if (agent.ctx.session && from !== id) {
              void agent.ctx.session
                .append({ type: 'mode_changed', ts: new Date().toISOString(), from, to: id })
                .catch(() => {});
            }
            return active?.name ?? null;
          }
        : undefined,
      registerDebugStreamCallback,
      restoreDebugStreamCallback,
      restoredMessages,
      restoredToolCalls,
      restoredEvents,
      ...createExecutionSessionCallbacks({ state, agent, session, worktreeSessions }),
      onResumeSession: withWorktreeSwitch(
        createTuiResumeCallback({ state, agent, tokenCounter, switchProviderAndModel, events }),
        (id) => worktreeSessions.get(id),
        switchProjectInPlace,
      ),
      getProjectPickerItems: () => getProjectPickerItems(pickerCtx),
      onProjectSelect: (slug: string, kind: 'project' | 'action') =>
        onProjectSelect(pickerCtx, slug, kind),
      initialAgentsMonitorOpen: !!flags.quick,
      tokenSavingMode: normalizeTokenSavingTier(config.features.tokenSavingMode),
      toolCount: agent.tools.list().length,
      onPanelOpen,
      memoryStore,
    } as never as import('@wrongstack/tui').RunTuiOptions);

    const spawnResult = await handleProjectSwitchSpawn({
      code,
      pendingProjectSwitch: state.pendingProjectSwitch,
    });
    if (spawnResult !== null) return { code, exitWith: spawnResult };
  } finally {
    renderer.setTuiActive(false);
    leaderAutoWake.dispose();
    offDirectorSpawned();
  }
  return { code };
}
