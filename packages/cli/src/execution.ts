import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { setQueuedMessagesSnapshot } from '@wrongstack/core/agent';
import { type CoordinatorEvent, isMailboxLeader } from '@wrongstack/core/coordination';
import {
  CHIMERA_REVIEW_PROMPT,
  type ChimeraReviewCompletePayload,
  type ChimeraReviewNeededPayload,
} from '@wrongstack/core/plugin';
import { attachTodosCheckpoint } from '@wrongstack/core/storage';
import {
  normalizeTokenSavingTier,
  type StopReason,
  type SubagentConfig,
} from '@wrongstack/core/types';
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
import { createSettingsAdapter } from './boot/tui-settings-adapter.js';
import { createBrainPanelHost } from './brain-menu/panel-service.js';
import {
  buildChimeraReviewTaskDescription,
  isChimeraAllClearReview,
  truncateAtCodePointBoundary,
} from './chimera-review-task.js';
import {
  applyChimeraReviewerReadOnlyPolicy,
  assignReviewerModelsRoundRobin,
  resolveReviewerFallbackModels,
} from './chimera-reviewer-policy.js';
import type { ExecuteDeps } from './execute-deps.js';
import { finalizeExecutionCleanup } from './execution-cleanup.js';
import { createKanbanDispatchHandler } from './execution-kanban-dispatch.js';
import { createReplFleetCallbacks } from './execution-repl-fleet-callbacks.js';
import { FleetStatusLine } from './fleet-statusline.js';

export type { LiveSettingsInput } from './live-settings-input.js';

import { waitForChimeraAskApproval } from './execution-chimera-ask.js';
import { installChimeraCascadeHandler } from './execution-chimera-cascade.js';
import { installStorageObservability } from './execution-storage-observability.js';
import { createTuiNextStepCallbacks } from './execution-tui-next-step-callbacks.js';
import { resolveActiveApiKey } from './provider-config-utils.js';
import { runRepl } from './repl.js';
import type { UpdateInfo } from './update-check.js';
import { CLI_VERSION } from './version.js';
import { createKanbanRunMirror } from './webui-server/kanban-run-mirror.js';

export {
  __resetReviewerRoundRobinCursor,
  applyChimeraReviewerReadOnlyPolicy,
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
      activateSessionIdentity,
      updateInfo: initialUpdateInfo,
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
      modeStore,
      detachTodosCheckpoint,
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

  let pendingChimeraWork: Promise<void> | undefined;

  events.onPattern('chimera.review_needed', (_event, payload) => {
    const p = payload as ChimeraReviewNeededPayload;
    const dir = director;
    if (!dir) {
      return;
    }
    if (p.files.length === 0) return;

    pendingChimeraWork = (async () => {
      let subagentId: string | undefined;
      try {
        const taskDesc = buildChimeraReviewTaskDescription(p);

        const tProvider = config.provider?.trim() || undefined;
        const tModel = config.model?.trim() || undefined;
        const rawProvider = p.reviewFallbackModels
          ? p.config.provider?.trim() || undefined
          : tProvider;
        const rawModel = p.reviewFallbackModels ? p.config.model?.trim() || undefined : tModel;
        const baseProvider = rawProvider || tProvider || config.provider;
        const baseModel = rawModel || tModel || config.model;
        const baseFallbacks = p.reviewFallbackModels
          ? [...p.reviewFallbackModels]
          : resolveReviewerFallbackModels(undefined);
        const assigned = assignReviewerModelsRoundRobin(baseProvider, baseModel, baseFallbacks);
        const cfg = applyChimeraReviewerReadOnlyPolicy({
          name: 'chimera-review',
          role: 'reviewer',
          systemPromptOverride: CHIMERA_REVIEW_PROMPT,
          maxIterations: 50,
          maxToolCalls: 250,
          timeoutMs: 900_000,
          provider: assigned.provider,
          model: assigned.model,
          fallbackModels: assigned.fallbackModels,
        });

        subagentId = await dir.spawn(cfg);
        const taskId = randomUUID();
        await dir.assign({
          id: taskId,
          description: taskDesc,
          subagentId,
        });

        const results = await dir.awaitTasks([taskId]);
        const result = results[0];
        if (result?.status !== 'success') {
          try {
            await session.append({
              type: 'error',
              ts: new Date().toISOString(),
              message: `🦂 Chimera review subagent ${result?.status ?? 'unknown'}: ${result?.error?.message ?? 'no result'}`,
              phase: 'agent',
            });
          } catch (err) {
            console.error(
              JSON.stringify({
                level: 'error',
                event: 'execution.chimera_append_failed',
                message: err instanceof Error ? err.message : String(err),
                timestamp: new Date().toISOString(),
              }),
            );
          }
          events.emitCustom('chimera.review_complete', {
            bundle: p,
            reviewText: '',
            status: result?.status ?? 'unknown',
            cwd: p.cwd,
            sessionId: session.id,
          } satisfies ChimeraReviewCompletePayload);
          return;
        }

        const reviewText =
          typeof result.result === 'string' ? result.result.trim() : JSON.stringify(result.result);

        events.emitCustom('chimera.review_complete', {
          bundle: p,
          reviewText,
          status: 'success',
          cwd: p.cwd,
          sessionId: session.id,
        } satisfies ChimeraReviewCompletePayload);

        if (reviewText) {
          await session.append({
            type: 'llm_response',
            ts: new Date().toISOString(),
            content: [{ type: 'text', text: reviewText }],
            stopReason: 'end_turn' as StopReason,
            usage: { input: 0, output: 0 },
          });

          const autoFix =
            (agent.ctx.meta['chimeraAutoFix'] as string | undefined) ?? p.config.autoFix ?? 'off';
          const reviewHasFindings = !isChimeraAllClearReview(reviewText);
          const isAskMode = autoFix === 'ask' && reviewHasFindings;
          const mailboxType = isAskMode ? 'ask' : 'result';
          const subject = isAskMode
            ? `🦂 Chimera review — ${p.files.length} file(s) changed. Shall I fix the findings?`
            : `🦂 Chimera review — ${p.files.length} file(s) changed`;

          let leaderApproved = false;
          let spawnedFix = false;
          let askMailMsgId: string | undefined;

          let leaderOnline = false;
          if (isAskMode) {
            try {
              const onlineAgents = await mailbox.getOnlineAgents();
              leaderOnline = onlineAgents.some(
                (a) => a.online && isMailboxLeader(a.agentId, a.role),
              );
            } catch (leaderCheckErr) {
              console.warn(
                JSON.stringify({
                  level: 'warn',
                  event: 'execution.chimera_leader_check_failed',
                  message:
                    leaderCheckErr instanceof Error
                      ? leaderCheckErr.message
                      : String(leaderCheckErr),
                  timestamp: new Date().toISOString(),
                }),
              );
            }
            if (!leaderOnline) {
              console.warn(
                JSON.stringify({
                  level: 'warn',
                  event: 'execution.chimera_mailbox_leader_offline',
                  message: `Leader not online — mailbox ${mailboxType} from chimera-review to leader will be delivered when leader reconnects`,
                  fileCount: p.files.length,
                  autoFix,
                  timestamp: new Date().toISOString(),
                }),
              );
            }
          } else {
            leaderOnline = true;
            console.debug(
              JSON.stringify({
                level: 'debug',
                event: 'execution.chimera_auto_no_presence_check',
                message:
                  'Result mode: leader presence not checked — mailbox message delivered regardless',
                fileCount: p.files.length,
                autoFix,
                timestamp: new Date().toISOString(),
              }),
            );
          }

          try {
            const askTimeoutRaw =
              (agent.ctx.meta['chimeraAskTimeoutMs'] as number | undefined) ?? 30_000;
            const ASK_TIMEOUT_MS = Number.isFinite(askTimeoutRaw)
              ? Math.max(0, askTimeoutRaw)
              : 30_000;
            const directive = isAskMode
              ? `LEADER ACTION REQUIRED: The Chimera review below found issues. Reply with "yes" to auto-fix, or "no" to skip (${ASK_TIMEOUT_MS / 1000}s timeout).`
              : reviewHasFindings
                ? 'LEADER ACTION REQUIRED: The Chimera review below found issues. Read the report and fix any Critical or High findings automatically using the edit tool. Verify with typecheck and linter.'
                : 'Chimera review completed with no findings. Read the report summary below; no fix action is requested.';
            const reviewBody =
              reviewText.length > 7500
                ? truncateAtCodePointBoundary(reviewText, 7500) +
                  '\n\n…(truncated, full report in session transcript)'
                : reviewText;
            const body = `${directive}\n\n${reviewBody}`;

            const mailMsg = await mailbox.send({
              from: 'chimera-review',
              to: 'leader',
              type: mailboxType,
              audience: 'leaders',
              subject,
              body,
              priority: 'normal',
            });
            if (!mailMsg?.id) throw new Error('mailbox.send returned no message id');
            askMailMsgId = mailMsg.id;

            if (isAskMode) {
              leaderApproved = await waitForChimeraAskApproval({
                mailbox,
                messageId: askMailMsgId,
                meta: agent.ctx.meta,
                session: agent.ctx.session ?? session,
                askTimeoutMs: ASK_TIMEOUT_MS,
              });
            }
          } catch (mailErr) {
            const errMsg = mailErr instanceof Error ? mailErr.message : String(mailErr);
            console.error(
              JSON.stringify({
                level: 'error',
                event: 'execution.chimera_mailbox_failed',
                message: errMsg,
                timestamp: new Date().toISOString(),
              }),
            );
            await session.append({
              type: 'error',
              ts: new Date().toISOString(),
              message: `🦂 Chimera auto-fix skipped — mailbox unreachable: ${errMsg}. Falling back to manual review mode.`,
              phase: 'agent',
            });
          }

          events.emitCustom('chimera.mailbox_delivered', {
            subject,
            autoFixMode: autoFix,
            fileCount: p.files.length,
            reviewLength: reviewText.length,
          });

          if (!leaderOnline) {
            try {
              await mailbox.send({
                from: 'chimera-review',
                to: 'leader',
                type: 'note',
                audience: 'leaders',
                subject: `⏰ Chimera review pending — ${p.files.length} file(s) checked`,
                body: `The leader was offline when a chimera review completed. A full review result with "LEADER ACTION REQUIRED" directive is waiting in this mailbox from chimera-review. Open it, read the findings, and fix any Critical or High issues.`,
                priority: 'high',
              });
            } catch (wakeErr) {
              console.warn(
                JSON.stringify({
                  level: 'warn',
                  event: 'execution.chimera_wakeup_companion_failed',
                  message: wakeErr instanceof Error ? wakeErr.message : String(wakeErr),
                  timestamp: new Date().toISOString(),
                }),
              );
            }
          }

          const shouldSpawnFix =
            !spawnedFix &&
            reviewHasFindings &&
            (autoFix === 'auto' || (isAskMode && leaderApproved)) &&
            reviewText.length > 0;

          if (shouldSpawnFix) {
            spawnedFix = true; // guard against double-spawn from poll race
            const fixTaskDesc = [
              `You are a fix agent. Apply the fixes requested in this review report.`,
              ``,
              `Repository: ${p.cwd}`,
              ``,
              `--- Review report ---`,
              truncateAtCodePointBoundary(reviewText, 12_000),
              ``,
              `--- Changed files ---`,
              p.files.map((f) => `- ${f.path}`).join('\n'),
              ``,
              `Read each file, understand the issue, apply fixes using the edit tool.`,
              `After fixing, run the project's typecheck and linter to verify.`,
              `Do NOT remove or reorder existing code unless the bug requires it.`,
            ].join('\n');

            try {
              const fixCfg: SubagentConfig = {
                name: 'chimera-fix',
                role: 'fixer',
                maxIterations: 60,
                maxToolCalls: 350,
                timeoutMs: 1_200_000,
              };
              const fixSubagentId = await dir.spawn(fixCfg);
              try {
                const fixTaskId = randomUUID();
                await dir.assign({
                  id: fixTaskId,
                  description: fixTaskDesc,
                  subagentId: fixSubagentId,
                });
                const fixResults = await dir.awaitTasks([fixTaskId]);
                const fixResult = fixResults[0];
                if (fixResult?.status === 'success') {
                  await session.append({
                    type: 'llm_response',
                    ts: new Date().toISOString(),
                    content: [
                      { type: 'text', text: `Chimera fix subagent completed: ${fixResult.result}` },
                    ],
                    stopReason: 'end_turn' as StopReason,
                    usage: { input: 0, output: 0 },
                  });
                } else {
                  await session.append({
                    type: 'error',
                    ts: new Date().toISOString(),
                    message: `Chimera fix subagent ${fixResult?.status ?? 'unknown'}: ${fixResult?.error?.message ?? 'no result'}`,
                    phase: 'agent',
                  });
                }
              } finally {
                try {
                  await dir.terminate(fixSubagentId);
                } catch {
                  /* best-effort */
                }
              }
            } catch (fixErr) {
              await session.append({
                type: 'error',
                ts: new Date().toISOString(),
                message: `🦂 Chimera auto-fix failed: ${fixErr instanceof Error ? fixErr.message : String(fixErr)}`,
                phase: 'agent',
              });
            }
          }
        }
      } catch (err) {
        try {
          await session.append({
            type: 'error',
            ts: new Date().toISOString(),
            message: `🦂 Chimera review failed: ${err instanceof Error ? err.message : String(err)}`,
            phase: 'agent',
          });
        } catch (appendErr) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'execution.chimera_review_append_failed',
              message: appendErr instanceof Error ? appendErr.message : String(appendErr),
              timestamp: new Date().toISOString(),
            }),
          );
        }
      } finally {
        if (subagentId) {
          try {
            await dir.terminate(subagentId);
          } catch {
            /* best-effort — subagent may already be gone */
          }
        }
      }
    })();
  });

  installChimeraCascadeHandler({
    events,
    director,
    session,
    getPendingWork: () => pendingChimeraWork,
    setPendingWork: (work) => {
      pendingChimeraWork = work;
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
            const summaries = await activeSessionStore.list(limit);
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
        skillLoader,
        promptLoader,
        modeStore,
        modeId,
        needsSetup,
        renderer,
        onAutonomy,
        applyLiveSettings,
        activateSessionIdentity,
        agentTranscripts,
        onModelContextResolved,
        sddSubagentFactory,
        statusTracker,
        ...createKanbanDispatchHandler({ config, events, skillLoader, sddSubagentFactory }),
      });
    } else {
      const headlessKanbanMirror = projectRoot
        ? createKanbanRunMirror({
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
      getPendingChimeraWork: () => pendingChimeraWork,
      director,
      reader,
    });
  }
  return code;
}
