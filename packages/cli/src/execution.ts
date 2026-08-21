import * as path from 'node:path';
import { effectiveFallbackChain, setQueuedMessagesSnapshot } from '@wrongstack/core/agent';
import type { CoordinatorEvent } from '@wrongstack/core/coordination';
import { updateReviewReportEvidence } from '@wrongstack/core/plugin';
import { attachTodosCheckpoint } from '@wrongstack/core/storage';
import { normalizeTokenSavingTier } from '@wrongstack/core/types';
import { mergeCustomModelDefs } from '@wrongstack/core/utils';
import { capabilitiesFor } from '@wrongstack/providers';
import { createToolVisionAdapters } from '@wrongstack/runtime/vision';
import { runSingleShotDispatch } from './boot/dispatch-singleshot.js';
import { runTuiDispatch } from './boot/dispatch-tui.js';
import { runWebUIDispatch } from './boot/dispatch-webui.js';
import { resolveExecutionMode } from './boot/execution-mode.js';
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
import { resumeSession } from './boot/tui-session-resume.js';
import { enrichStubSummaries } from './boot/tui-session-stub-enrich.js';
import { createSettingsAdapter } from './boot/tui-settings-adapter.js';
import { createThemeAdapter } from './boot/tui-theme-adapter.js';
import { createBrainPanelHost } from './brain-menu/panel-service.js';
import { buildMutatingAgentLadder } from './chimera-reviewer-policy.js';
import type { ExecuteDeps } from './execute-deps.js';
import { finalizeExecutionCleanup } from './execution-cleanup.js';
import { createKanbanDispatchHandler } from './execution-kanban-dispatch.js';
import { createReplFleetCallbacks } from './execution-repl-fleet-callbacks.js';
import { FleetStatusLine } from './fleet-statusline.js';

export type { LiveSettingsInput } from './live-settings-input.js';

import { createChimeraWorkRegistry } from './chimera-work-registry.js';
import { installChimeraCascadeHandler } from './execution-chimera-cascade.js';
import { installChimeraReviewHandler } from './execution-chimera-review.js';
import { installStorageObservability } from './execution-storage-observability.js';
import { createTuiNextStepCallbacks } from './execution-tui-next-step-callbacks.js';
import { resolveActiveApiKey } from './provider-config-utils.js';
import { runRepl } from './repl.js';
import { createTuiResourceMenuGetter } from './tui-resource-menus.js';
import type { UpdateInfo } from './update-check.js';
import { CLI_VERSION } from './version.js';

export {
  __resetReviewerRoundRobinCursor,
  applyChimeraReviewerReadOnlyPolicy,
  assignReviewerModels,
  assignReviewerModelsRoundRobin,
  CHIMERA_REVIEW_READ_ONLY_TOOLS,
  resolveReviewerFallbackModels,
} from './chimera-reviewer-policy.js';

export type {
  BrainData,
  BrainLogEntry,
  ExecuteDeps,
  McpPickerItem,
  PluginPickerItem,
  RestoredToolCall,
  ToolPickerItem,
} from './execute-deps.js';

export async function execute(deps: ExecuteDeps): Promise<number> {
  const {
    core: {
      agent,
      events,
      config,
      configStore,
      wpaths: initialWpaths,
      projectRoot: initialProjectRoot,
      flags,
      positional,
      slashRegistry,
      tokenCounter,
      sessionRef,
      activateSessionIdentity,
      updateInfo: initialUpdateInfo,
      webuiSessionChild,
    },
    session: {
      session,
      context,
      attachments,
      queueStore,
      mcpRegistry,
      mailbox,
      sessionStore,
      memoryStore,
      vectorMemoryStore: vectorMemoryStoreFromExecute,
      vectorMemoryModelCacheDir: vectorMemoryModelCacheDirFromExecute,
      modeStore,
      detachTodosCheckpoint,
      rebindTodosCheckpoint,
      restoredMessages,
      restoredToolCalls,
      restoredEvents,
      needsSetup,
    },
    provider: {
      modelsRegistry,
      savedProviderCfg,
      resolvedProvider,
      statusTracker,
      getPickableProviders,
      switchProviderAndModel,
      onModelContextResolved,
      sddSubagentFactory,
    },
    ui: {
      renderer,
      reader,
      secretInputController,
      stats,
      effectiveMaxContext,
      getEffectiveMaxContext,
      skillLoader,
      promptLoader,
      modeId,
    },
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
      buildEnhancerProvider,
      getEnhanceFallbackRef,
      getConfiguredRefinerRef,
      statuslineHiddenItems,
      setStatuslineHiddenItems,
      saveStatuslineHiddenItems,
      getYolo,
      onYolo,
      getAutonomy,
      onAutonomy,
      getNextPredict,
      applyLiveSettings,
      onCountdownTick,
    },
    picker: {
      getPluginItems,
      onPluginToggle,
      getMcpServers,
      onMcpToggle,
      onMcpRestart,
      getToolsItems,
      onToolToggle,
      getBrainData,
      onBrainRiskLevel,
      getBrainLog,
      brain,
      brainSettings,
      brainRuntime,
      getShadowData,
      onShadowStart,
      onShadowStop,
    } = {},
    lifecycles: {
      getSuggestions,
      getAutoSuggestions,
      onSuggestionsParsed,
      autonomyNextPrompt,
      autoProceedDelayMs,
      autoProceedMaxIterations,
      onValidateAutoProceed,
      getEternalEngine,
      getParallelEngine,
      getSddRun,
      onSddLifecycle,
      subscribeEternalIteration,
      subscribeEternalStage,
      onDestroy,
      onCoordinatorStop,
    } = {},
  } = deps;

  let onCoordinatorStopImpl: (() => void) | undefined = onCoordinatorStop;

  const wpaths = initialWpaths;
  const projectRoot = initialProjectRoot;
  const activeSessionStore = sessionStore;
  const detachActiveTodosCheckpoint: (() => void | Promise<void>) | undefined =
    detachTodosCheckpoint;
  const profileName = config.activeProfile ?? 'default';
  const bootUpdateInfo: UpdateInfo | undefined = initialUpdateInfo;

  const offStorageObservability = installStorageObservability(events, context.traceId);

  const chimeraWork = createChimeraWorkRegistry();

  installChimeraReviewHandler({
    events,
    director,
    session,
    mailbox,
    agent,
    config,
    projectDir: wpaths.projectDir,
    // Thread the shared tracker so the round-robin Chimera reviewer picks
    // skip (provider, model) pairs currently in the waiting room. Without
    // this, a 429-stricken model is re-spawned on every concurrent reviewer
    // turn and burns the whole chain instead of staying quarantined.
    statusTracker,
    trackWork: (work) => {
      chimeraWork.track(work);
    },
  });

  installChimeraCascadeHandler({
    events,
    director,
    session,
    buildLadder: () =>
      buildMutatingAgentLadder({
        profileChain: effectiveFallbackChain(config),
        session: { provider: config.provider, model: config.model },
      }),
    getPendingWork: () => chimeraWork.pending(),
    persistEvidence: async (reportId, status, checks) => {
      await updateReviewReportEvidence(reportId, wpaths.projectDir, status, checks);
    },
    trackWork: (work) => {
      chimeraWork.track(work);
    },
  });

  let code = 0;
  let fleetStatusLine: FleetStatusLine | null = null;
  try {
    const visionAdapters = () => createToolVisionAdapters(agent.tools);
    const supportsVision = async (): Promise<boolean> => {
      try {
        const providerConfig = config.providers?.[context.provider.id];
        const mergedModels = mergeCustomModelDefs(providerConfig?.customModels, config.models);
        const caps = await capabilitiesFor(
          modelsRegistry,
          context.provider.id,
          context.model,
          mergedModels,
        );
        return caps.vision;
      } catch {
        return context.provider.capabilities.vision;
      }
    };
    const promptFlag = typeof flags['prompt'] === 'string' ? flags['prompt'] : undefined;
    if (promptFlag) {
      positional.unshift(promptFlag);
    }
    const goalFlag = typeof flags['goal'] === 'string' ? flags['goal'] : undefined;
    const askFlag = typeof flags['ask'] === 'string' ? flags['ask'] : undefined;
    if ((goalFlag || askFlag) && positional.length === 0 && !promptFlag) {
      flags.tui = true;
    }
    const executionMode = resolveExecutionMode(positional, flags);
    const enteringTui = executionMode === 'tui';
    if (!enteringTui) {
      fleetStatusLine = new FleetStatusLine({ events, version: CLI_VERSION });
      fleetStatusLine.start();
    }
    if (executionMode === 'single-shot') {
      code = await runSingleShotDispatch({
        agent,
        query: positional.join(' '),
        flags,
        tokenCounter,
        renderer,
      });
    } else if (executionMode === 'tui') {
      agent.disableInteractiveConfirmation();

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
            wpaths,
            mailbox,
            director,
            getDirector,
            coordinatorController,
            onCoordinatorStopSetter: (fn) => {
              onCoordinatorStopImpl = fn ?? undefined;
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

      const pickerCtx: ProjectPickerContext = {
        state,
        renderer,
        director,
        getEternalEngine,
        getParallelEngine,
        switchCtx,
        switchProjectInPlace,
      };

      renderer.setTuiActive(true);
      try {
        code = await runTuiDispatch({
          agent,
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
            fleetStreamController,
            applyLiveSettings,
          }),
          ...createThemeAdapter({ configStore, wpaths }),
          configStore,
          effectiveMaxContext,
          titleAnimation:
            ((config.autonomy as Record<string, unknown> | undefined)?.[
              'terminalTitleAnimation'
            ] as boolean) ?? true,
          chime:
            ((config.autonomy as Record<string, unknown> | undefined)?.['chime'] as boolean) ??
            false,
          confirmExit:
            ((config.autonomy as Record<string, unknown> | undefined)?.[
              'confirmExit'
            ] as boolean) ?? true,
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
                  }
                | { type: 'resetContextChip' }
                | { type: 'streamReset' }
                | { type: 'toolStreamClear' },
            ) => void,
          ) => {
            dispatch({ type: 'clearHistory', model: context.model, provider: context.provider.id });
            dispatch({ type: 'resetContextChip' });
            dispatch({ type: 'streamReset' });
            dispatch({ type: 'toolStreamClear' });
          },
          fleetStreamController,
          interruptController,
          enhanceController,
          getEnhancerReasoning,
          buildEnhancerProvider,
          getEnhanceFallbackRef,
          getConfiguredRefinerRef,
          statuslineHiddenItems,
          setStatuslineHiddenItems,
          saveStatuslineHiddenItems,
          getPluginItems,
          onPluginToggle,
          getMcpServers,
          onMcpToggle,
          onMcpRestart,
          getToolsItems,
          onToolToggle,
          getBrainData,
          onBrainRiskLevel,
          brainPanelHost: brainRuntime ? createBrainPanelHost({ brainRuntime }) : undefined,
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
          listSessions: async (limit = 20) => {
            if (!activeSessionStore) return [];
            const raw = await activeSessionStore.list(limit);
            // Killed sessions leave create-time stub summaries (empty title,
            // lastActivityAt == startedAt). Repair picker-facing fields from
            // their intact JSONL transcripts so /resume shows real titles.
            const summaries = await enrichStubSummaries(raw, wpaths.projectSessions);
            const currentId = agent.ctx.session?.id ?? session.id;
            return summaries.map((s) => ({
              id: s.id,
              title: s.title ?? '',
              name: s.name,
              lastUserMessage: s.lastUserMessage,
              messageCount: s.messageCount,
              lastActivityAt: s.lastActivityAt,
              startedAt: s.startedAt ?? '',
              endedAt: s.endedAt,
              tokenTotal: s.tokenTotal ?? 0,
              iterationCount: s.iterationCount ?? 0,
              toolCallCount: s.toolCallCount ?? 0,
              toolErrorCount: s.toolErrorCount ?? 0,
              outcome: s.outcome,
              isCurrent: s.id === currentId,
            }));
          },
          onResumeSession: (sessionId: string) =>
            resumeSession(
              { state, agent, tokenCounter, switchProviderAndModel, events },
              sessionId,
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
        if (spawnResult !== null) return spawnResult;
      } finally {
        renderer.setTuiActive(false);
        offDirectorSpawned();
      }
    } else if (executionMode === 'webui') {
      code = await runWebUIDispatch({
        agent,
        events,
        session,
        config,
        flags,
        projectRoot,
        globalConfigPath: wpaths.globalConfig,
        profileConfigPath: wpaths.profileConfig(profileName),
        projectSessionsDir: wpaths.projectSessions,
        modelsRegistry,
        mcpRegistry,
        brain,
        brainSettings,
        brainRuntime,
        getBrainLog,
        subscribeEternalIteration,
        sessionStore: activeSessionStore,
        memoryStore,
        getVectorMemoryStore: () => vectorMemoryStoreFromExecute,
        vectorMemoryModelCacheDir: vectorMemoryModelCacheDirFromExecute,
        skillLoader,
        promptLoader,
        modeStore,
        modeId,
        needsSetup,
        renderer,
        onAutonomy,
        applyLiveSettings,
        activateSessionIdentity,
        rebindTodosCheckpoint,
        agentTranscripts,
        onModelContextResolved,
        sddSubagentFactory,
        statusTracker,
        updateInfo: bootUpdateInfo,
        webuiSessionChild,
        getFleetBudget: () => {
          const d = getDirector?.() ?? null;
          if (!d) return null;
          const snap = d.fleetManager?.budgetSnapshot?.();
          const maxSpawns = snap?.maxSpawns ?? d.maxSpawns;
          const usedSpawns = snap?.usedSpawns ?? d.spawnCount;
          const remainingSpawns =
            snap?.remainingSpawns ??
            Math.max(
              0,
              (Number.isFinite(maxSpawns) ? maxSpawns : Number.POSITIVE_INFINITY) - usedSpawns,
            );
          const activeAgents = d
            .status()
            .subagents.filter((s) => s.status === 'running' || s.status === 'idle').length;
          return {
            maxSpawns,
            usedSpawns,
            remainingSpawns,
            activeAgents,
            ...(snap?.checkpointMaxSpawns !== undefined
              ? { checkpointMaxSpawns: snap.checkpointMaxSpawns }
              : {}),
            ...(snap?.ceilingMismatch ? { ceilingMismatch: true } : {}),
          };
        },
        ...createKanbanDispatchHandler({ config, events, skillLoader, sddSubagentFactory }),
      });
    } else {
      // Imported here rather than at module scope: this is the ONLY static
      // path from the always-loaded CLI graph into `@wrongstack/webui-server`
      // (831KB, +38.7MB heap / +80.2MB RSS standalone). `webui-server.ts`
      // itself is already loaded lazily from `boot/dispatch-webui.ts`, so this
      // one import was single-handedly defeating that boundary and making every
      // `wstack` invocation pay for a WebUI server that is off by default.
      const headlessKanbanMirror = projectRoot
        ? (await import('./webui-server/kanban-run-mirror.js')).createKanbanRunMirror({
            projectRoot,
            events,
            broadcast: () => {},
            log: (m) => console.log(m),
          })
        : null;
      try {
        code = await runRepl({
          agent,
          renderer,
          reader,
          slashRegistry,
          tokenCounter,
          visionAdapters,
          supportsVision,
          attachments,
          effectiveMaxContext,
          getEffectiveMaxContext,
          projectName: path.basename(projectRoot) || undefined,
          projectRoot,
          appConfig: config,
          getSessionId: () => agent.ctx.session?.id ?? session.id,
          getAutonomy,
          onAutonomy,
          getNextPredict,
          onSuggestionsParsed,
          getSuggestions,
          getAutoSuggestions,
          getYolo,
          autonomyNextPrompt,
          autoProceedDelayMs,
          onValidateAutoProceed,
          autoProceedMaxIterations,
          getEternalEngine,
          getParallelEngine,
          getSddRun,
          skillLoader,
          agentsMonitorController,
          fleetStreamController,
          interruptController,
          ...createReplFleetCallbacks({ director, getDirector }),
          onCountdownTick,
          onDestroy,
        });
      } finally {
        headlessKanbanMirror?.dispose();
      }
    }
  } finally {
    await finalizeExecutionCleanup({
      offStorageObservability,
      fleetStatusLine,
      onCoordinatorStop: onCoordinatorStopImpl,
      stats,
      renderer,
      detachTodosCheckpoint,
      mcpRegistry,
      agent,
      session,
      tokenCounter,
      events,
      chimeraWork,
      director,
      reader,
    });
  }
  return code;
}
