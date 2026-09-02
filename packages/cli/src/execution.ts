import * as path from 'node:path';
import { effectiveFallbackChain, setQueuedMessagesSnapshot } from '@wrongstack/core/agent';
import type { CoordinatorEvent } from '@wrongstack/core/coordination';
import { updateReviewReportEvidence } from '@wrongstack/core/plugin';
import { attachTodosCheckpoint } from '@wrongstack/core/storage';
import type { SessionLoadProgress } from '@wrongstack/core/types';
import { normalizeTokenSavingTier } from '@wrongstack/core/types';
import { hasOpenTodos, mergeCustomModelDefs } from '@wrongstack/core/utils';
import { capabilitiesFor } from '@wrongstack/providers';
import { createToolVisionAdapters } from '@wrongstack/runtime/vision';
import { parseNextSteps } from '@wrongstack/tools/next-steps';
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
import { selectPickerSessions } from './boot/tui-session-stub-enrich.js';
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
import { setAutoSuggestions } from './services/suggestion-store.js';
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
      releaseSessionHelpers,
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
  // Session-scoped disposers for the chimera wildcard listeners — the
  // installers push their `onPattern` disposers here and the finally block
  // below drains them at session end (EventBus wildcard-leak board card).
  const chimeraTeardowns: Array<() => void> = [];

  installChimeraReviewHandler({
    events,
    director,
    session,
    mailbox,
    agent,
    config,
    projectDir: wpaths.projectDir,
    teardownHandlers: chimeraTeardowns,
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
    teardownHandlers: chimeraTeardowns,
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
            // Enrichment can raise a stub's lastActivityAt, so selection must
            // happen after enrichment: fetch an over-fetched pool from the
            // store, enrich stubs from their JSONL transcripts, re-sort, slice.
            const summaries = await selectPickerSessions(
              (poolLimit) => activeSessionStore.list(poolLimit),
              wpaths.projectSessions,
              limit,
            );
            // Which of these is another process writing right now? Session
            // SUMMARIES carry no liveness — they are built from the journal —
            // so the picker used to offer live sessions as if they were
            // history, and only the host's reservation (seconds and a
            // multi-hundred-MB read later) refused. Cross-reference the
            // registry so the refusal happens before any of that.
            //
            // Best-effort: a registry that cannot be read must not take the
            // picker down with it. The host reservation is still the
            // authority, and it fails closed.
            const liveBySession = new Map<
              string,
              { pid: number; clientType?: string | undefined }
            >();
            try {
              for (const entry of await getLiveSessions({ state })) {
                if (entry.pid == null) continue;
                liveBySession.set(entry.sessionId, {
                  pid: entry.pid,
                  ...(entry.clientType ? { clientType: entry.clientType } : {}),
                });
              }
            } catch {
              /* liveness is an ADDITIONAL guard, never a listing prerequisite */
            }
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
              // The session this process owns is `isCurrent`, not "live
              // elsewhere" — it holds its own lease and would otherwise be
              // labelled as owned by another surface.
              ...(s.id !== currentId && liveBySession.has(s.id)
                ? { live: liveBySession.get(s.id) }
                : {}),
            }));
          },
          onResumeSession: async (
            sessionId: string,
            onLoadProgress?: (progress: SessionLoadProgress) => void,
            // Live stage names for the TUI's resume block. Purely a display
            // channel: it never changes what the resume does.
            onStage?: (stage: string) => void,
          ) => {
            // `resumeSession` returns `null` only when the JOURNAL could not be
            // read — every other failure now comes back as a read-only result
            // carrying the reason in `warnings`, because a transcript that
            // loaded is worth showing even when ownership was not taken. When
            // it does return null the reason went to stderr, which the TUI
            // owns, so the user would otherwise see a bare "Failed to resume
            // session <id>.". Capture the reason and REJECT with it instead:
            // both TUI resume surfaces render `.catch` text into the chat.
            let failure: import('./boot/tui-session-resume.js').SessionResumeFailure | undefined;
            const result = await resumeSession(
              {
                state,
                agent,
                tokenCounter,
                switchProviderAndModel,
                events,
                onLoadProgress,
                onStage,
                onFailure: (info) => {
                  failure = info;
                },
              },
              sessionId,
            );
            if (!result) {
              throw new Error(
                failure
                  ? `${failure.message} (at ${failure.stage})`
                  : `Session "${sessionId}" could not be resumed.`,
              );
            }
            // ── Next steps of the RESUMED session ────────────────────────
            // A session that ended on a `<nextsteps>` block must come back
            // with those steps offered, not executed: the user picks one (or
            // types something else) and nothing runs until they do.
            //
            // Deliberately NOT `parseSuggestionsFromOutput`: that helper arms
            // `auto="true"` items as a side effect, which is precisely the
            // "it resumed and then just carried on by itself" behaviour. A
            // resume clears the auto store instead — including any items left
            // over from the session being left, which would otherwise fire the
            // moment the post-resume hold is released.
            setAutoSuggestions([]);
            // Open todos keep their precedence over suggestions, exactly as in
            // the live turn: the board is the continuation authority, and
            // offering `/next 1` beside it would let an arbitrary prompt
            // displace the next todo.
            const resumedNextSteps =
              result.attached && !hasOpenTodos(agent.ctx.todos) && result.lastAssistantText
                ? parseNextSteps(result.lastAssistantText).texts
                : [];
            return { ...result, nextSteps: resumedNextSteps };
          },
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
        // Stopping a tab's run stops the work that tab started — its
        // subagents included. Aborting the leader's controller only unwinds
        // workers it is BLOCKED on; anything started with `spawn_subagent` +
        // `assign_task` keeps going unless asked to stop. Scoped to the
        // session so one tab's Stop never reaches another tab's fleet.
        stopSessionFleet: async (sessionId: string) => {
          await getDirector?.()?.terminateSession(sessionId);
        },
        // Closing a tab is not stopping it. The run keeps going and keeps its
        // fleet; what goes is the background help pinned to that conversation
        // — the explore companion's poll timer and the shadow reviewer's
        // bookkeeping — which nobody is watching any more.
        ...(releaseSessionHelpers ? { onSessionRetired: releaseSessionHelpers } : {}),
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
    // Release session-scoped wildcard listeners (chimera review/cascade)
    // BEFORE the cleanup drains below, so no stale listener survives into
    // teardown — the EventBus wildcard-disposer fix.
    for (const off of chimeraTeardowns.splice(0)) {
      try {
        off();
      } catch {
        /* best-effort — a throwing disposer must not block cleanup */
      }
    }
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
