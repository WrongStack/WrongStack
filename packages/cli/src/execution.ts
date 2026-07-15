/**
 * Execution phase — single-shot, TUI, REPL, and WebUI dispatch.
 *
 * Composition root for the three run modes. The dispatch fork at the
 * tail of `execute()` selects a mode based on flags:
 *
 *   `if (positional.length > 0)`        → single-shot  (boot/dispatch-singleshot.ts)
 *   `else if (flags.tui)`               → TUI          (this file + boot/tui-*.ts)
 *   `else if (flags.webui)`             → WebUI        (boot/dispatch-webui.ts)
 *   `else`                              → REPL         (repl.ts)
 *
 * ## Extracted modules (boot/)
 *
 * The TUI branch was decomposed into focused sub-modules. Each owns
 * one concern and mutates shared state through `TuiRuntimeState`:
 *
 *   boot/tui-runtime-state.ts            — shared mutable context type
 *   boot/tui-autophase-wiring.ts         — AutoPhase event forwarding
 *   boot/tui-coordinator-setup.ts        — AutonomousCoordinator factory + lifecycle hook
 *   boot/tui-project-switch.ts           — switchProjectInPlace (re-root live process)
 *   boot/tui-project-spawn.ts            — post-runTui project-switch spawn
 *   boot/tui-project-picker-callback.ts  — getProjectPickerItems + onProjectSelect
 *   boot/tui-settings-adapter.ts         — getSettings + saveSettings
 *   boot/tui-session-resume.ts           — onResumeSession
 *   boot/tui-live-sessions.ts            — getLiveSessions + onSwitchToSession
 *   boot/tui-sdd-callback.ts             — getSDDContext + onSDDOutput
 *   boot/tui-debug-stream.ts             — registerDebugStreamCallback + restoreDebugStreamCallback
 *
 * Adding a new TUI callback: create a `boot/tui-<name>.ts` module,
 * receive `TuiRuntimeState` as a parameter, and add a thin reference
 * in the `runTui()` options literal below. Do NOT grow this file.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  attachTodosCheckpoint,
  CHIMERA_REVIEW_PROMPT,
  type ChimeraReviewNeededPayload,
  type CoordinatorEvent,
  type FleetChatVerbosity,
  fallbackProfileChain,
  mergeCustomModelDefs,
  normalizeTokenSavingTier,
  parseModelRef,
  type SubagentConfig,
  setQueuedMessagesSnapshot,
  type TokenSavingTier,
  WIDE_SUBAGENT_CAPABILITIES,
} from '@wrongstack/core';
import { capabilitiesFor } from '@wrongstack/providers';
import { createToolVisionAdapters } from '@wrongstack/runtime/vision';
import { runSingleShotDispatch } from './boot/dispatch-singleshot.js';
import { runWebUIDispatch } from './boot/dispatch-webui.js';
import { createKanbanRunMirror } from './webui-server/kanban-run-mirror.js';
import { wireAutoPhase } from './boot/tui-autophase-wiring.js';
import { setupAutonomousCoordinator } from './boot/tui-coordinator-setup.js';
import { registerDebugStreamCallback, restoreDebugStreamCallback } from './boot/tui-debug-stream.js';
import { getLiveSessions, onSwitchToSession } from './boot/tui-live-sessions.js';
import { getProjectPickerItems, onProjectSelect, type ProjectPickerContext } from './boot/tui-project-picker-callback.js';
import { handleProjectSwitchSpawn } from './boot/tui-project-spawn.js';
import { switchProjectInPlace as switchProjectInPlaceExtracted, type ProjectSwitchContext } from './boot/tui-project-switch.js';
import type { TuiRuntimeState } from './boot/tui-runtime-state.js';
import { getSDDContext as getSDDContextExtracted, onSDDOutput as onSDDOutputExtracted } from './boot/tui-sdd-callback.js';
import { resumeSession } from './boot/tui-session-resume.js';
import { createSettingsAdapter } from './boot/tui-settings-adapter.js';
import { FleetStatusLine } from './fleet-statusline.js';
import { createBrainPanelHost } from './brain-menu/panel-service.js';
import { type PredictLLMProvider, predictNextTasks } from './next-task-predictor.js';
import { resolveActiveApiKey } from './provider-config-utils.js';
import { parseSuggestionsFromOutput, runRepl } from './repl.js';
import { setSuggestions } from './slash-commands/suggestion-store.js';
import { CLI_VERSION } from './version.js';
import type { ExecuteDeps } from './execute-deps.js';

/**
 * Settings payload shared by `saveSettings` (persist) and `applyLiveSettings`
 * (apply to the running session). Mirrors the fields the TUI `/settings` picker
 * cycles with ←/→.
 */
export interface LiveSettingsInput {
  mode?: 'off' | 'suggest' | 'auto' | undefined;
  delayMs?: number | undefined;
  titleAnimation?: boolean | undefined;
  yolo?: boolean | undefined;
  /** @deprecated Use fleetChatVerbosity; kept for boolean-only writers. */
  streamFleet?: boolean | undefined;
  /** Fleet-chat verbosity (off | compact | full); persists with a mirrored streamFleet boolean. */
  fleetChatVerbosity?: FleetChatVerbosity | undefined;
  chime?: boolean | undefined;
  confirmExit?: boolean | undefined;
  nextPrediction?: boolean | undefined;
  featureMcp?: boolean | undefined;
  featurePlugins?: boolean | undefined;
  featureMemory?: boolean | undefined;
  featureSkills?: boolean | undefined;
  featureModelsRegistry?: boolean | undefined;
  featureTokenSaving?: TokenSavingTier | undefined;
  allowOutsideProjectRoot?: boolean | undefined;
  contextAutoCompact?: boolean | undefined;
  contextStrategy?: string | undefined;
  contextMode?: string | undefined;
  maxConcurrent?: number | undefined;
  logLevel?: string | undefined;
  auditLevel?: string | undefined;
  indexOnStart?: boolean | undefined;
  maxIterations?: number | undefined;
  autoProceedMaxIterations?: number | undefined;
  /** When true, file tools are confined to the project root. Default false. */
  restrictFsToRoot?: boolean | undefined;
  debugStream?: boolean | undefined;
  configScope?: 'global' | 'project' | undefined;
  enhanceDelayMs?: number | undefined;
  enhanceEnabled?: boolean | undefined;
  enhanceLanguage?: string | undefined;
  /** Mid-run send-mode picker (queue/btw/steer) toggle. Default on. */
  midRunSendPicker?: boolean | undefined;
  /** Skip the confirmation prompt for the TUI `!<command>` shell shortcut. */
  shellBangWarningDontShowAgain?: boolean | undefined;
  mouseMode?: boolean | undefined;
  autonomyNextPrompt?: string | undefined;
  /** Whether the process circuit breaker gates bash/exec. Default false. */
  breakerEnabled?: boolean | undefined;
  /** Auto kill/reset delay (ms) when the breaker trips. 0 = manual recovery. */
  breakerAutoKillResetMs?: number | undefined;
  /** TUI statusline density. Defaults to detailed when unset. */
  statuslineMode?: 'minimum' | 'detailed' | undefined;
  /** Single word shown in the TUI rainbow working-state chip. */
  thinkingWord?: string | undefined;
  /** Animation style for the TUI working-state chip. */
  animationStyle?: 'rainbow' | 'wave' | 'pulse' | 'dots' | 'breathe' | 'cycle' | undefined;
  /** Provider-runtime reasoning mode. */
  reasoningMode?: 'auto' | 'on' | 'off' | undefined;
  /** Provider-runtime reasoning effort. */
  reasoningEffort?: string | undefined;
  /** Preserve thinking blocks across turns when supported. */
  reasoningPreserve?: boolean | undefined;
  /** Prompt-cache TTL, or default to clear the explicit override. */
  cacheTtl?: 'default' | '5m' | '1h' | undefined;
}

export type { ExecuteDeps, PluginPickerItem, McpPickerItem, ToolPickerItem, BrainData, BrainLogEntry, RestoredToolCall } from './execute-deps.js';

export async function execute(deps: ExecuteDeps): Promise<number> {
  const {
    core: {
      agent, events, config, configStore, wpaths: initialWpaths,
      projectRoot: initialProjectRoot, flags, positional, slashRegistry,
      tokenCounter, recoveryLock: initialRecoveryLock,
    },
    session: {
      session, context, attachments, queueStore, mcpRegistry, mailbox,
      sessionStore, memoryStore, modeStore, detachTodosCheckpoint,
      restoredMessages, restoredToolCalls, needsSetup,
    },
    provider: {
      modelsRegistry, savedProviderCfg, resolvedProvider,
      getPickableProviders, switchProviderAndModel, onModelContextResolved,
      sddSubagentFactory,
    },
    ui: {
      renderer, reader, stats, effectiveMaxContext, getEffectiveMaxContext,
      skillLoader, promptLoader, modeId,
    },
    fleet: {
      director, getDirector, coordinatorController, fleetRoster,
      fleetStreamController, agentsMonitorController, agentTranscripts,
      authHost, onPanelOpen,
    },
    controllers: {
      interruptController, enhanceController, getEnhancerReasoning,
      buildEnhancerProvider, getEnhanceFallbackRef,
      statuslineHiddenItems, setStatuslineHiddenItems, saveStatuslineHiddenItems,
      getYolo, onYolo, getAutonomy, onAutonomy, getNextPredict,
      applyLiveSettings, onCountdownTick,
    },
    picker: {
      getPluginItems, onPluginToggle, getMcpServers, onMcpToggle, onMcpRestart,
      getToolsItems, onToolToggle, getBrainData, onBrainRiskLevel, getBrainLog,
      brain, brainSettings, brainRuntime, getShadowData, onShadowStart, onShadowStop,
    } = {},
    lifecycles: {
      getSuggestions, getAutoSuggestions, onSuggestionsParsed,
      autonomyNextPrompt, autoProceedDelayMs, autoProceedMaxIterations,
      onValidateAutoProceed, getEternalEngine, getParallelEngine, getSddRun,
      onSddLifecycle, subscribeEternalIteration, subscribeEternalStage,
      onDestroy, onCoordinatorStop,
    } = {},
  } = deps;

  // Mutable local for onCoordinatorStop — the coordinator setup in the TUI
  // branch reassigns it via the onCoordinatorStopSetter callback.
  let onCoordinatorStopImpl: (() => void) | undefined = onCoordinatorStop;

  const wpaths = initialWpaths;
  const projectRoot = initialProjectRoot;
  const activeSessionStore = sessionStore;
  const activeRecoveryLock = initialRecoveryLock;
  /** Updated by the TUI branch on project switch so cleanup clears the correct lock. */
  let currentRecoveryLock = activeRecoveryLock;
  const detachActiveTodosCheckpoint: (() => void | Promise<void>) | undefined =
    detachTodosCheckpoint;

  // ── Storage observability: relay storage.* events to stdout as structured JSON ──
  // The root traceId from the Context is the primary correlation ID. Storage
  // events emitted by FileSessionWriter (flush, close) carry their own traceId
  // (propagated from ContextInit) which we also included; events from the
  // DefaultSessionStore level (load, summary, compact) inherit it from context.
  const rootTraceId = context.traceId;
  const storageLog = (event: string, payload: Record<string, unknown>) => {
    // Merge: prefer the storage-event-level traceId (from FileSessionWriter) over
    // the root traceId when both are present, so Fleet/spans are precisely keyed.
    const traceId = (payload.traceId as string | undefined) ?? rootTraceId;
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: 'info',
        event,
        timestamp: new Date().toISOString(),
        traceId,
        ...payload,
      }),
    );
  };
  const onStorageRead = (...args: unknown[]) =>
    storageLog('storage.read', args[0] as Record<string, unknown>);
  const onStorageWrite = (...args: unknown[]) =>
    storageLog('storage.write', args[0] as Record<string, unknown>);
  const onStorageError = (...args: unknown[]) =>
    storageLog('storage.error', args[0] as Record<string, unknown>);
  const offStorageRead = events.on('storage.read', onStorageRead);
  const offStorageWrite = events.on('storage.write', onStorageWrite);
  const offStorageError = events.on('storage.error', onStorageError);

  // Tracks the in-flight chimera subagent so finally can await it before session.close().
  // Without this, the fire-and-forget IIFE appends to a session whose handle is already closed.
  let pendingChimeraWork: Promise<void> | undefined;

  // ── Chimera post-session review: spawns subagent on chimera.review_needed ──
  events.onPattern('chimera.review_needed', (_event, payload) => {
    const p = payload as ChimeraReviewNeededPayload;
    const dir = director;
    if (!dir) {
      // Director not active — review skipped. Chimera needs --director flag.
      return;
    }
    if (p.files.length === 0) return;

    // Store the promise so the finally block can await it before session.close().
    // events.emit('session.ended') fires synchronously, so this assignment
    // happens before the finally block checks pendingChimeraWork.
    pendingChimeraWork = (async () => {
      try {
        const fileList = p.files.map((f) => `- [${f.status.toUpperCase()}] ${f.path}`).join('\n');

        const taskDesc = [
          `Review the following ${p.files.length} file(s) changed in this session at ${p.cwd}.`,
          '',
          fileList,
          '',
          '---',
          '',
          'Read each file using the read tool. Check for bugs, type issues,',
          'security problems, and produce a structured review report.',
        ].join('\n');

        // Role-based model matrix resolution: the Director.spawn() resolves
        // provider/model from the model matrix by role (→ phase → * → leader)
        // when no explicit model is set. This lets `/setmodel set reviewer <p>/<m>`
        // control the review model. Budget is generous because reviews regularly
        // need 15–19 iterations, 21+ tools, and 2+ minutes of wall time for
        // deep multi-file reading + git cross-referencing.
        const cfg: SubagentConfig = {
          name: 'chimera-review',
          role: 'reviewer',
          systemPromptOverride: CHIMERA_REVIEW_PROMPT,
          maxIterations: 50,
          maxToolCalls: 250,
          timeoutMs: 900_000,
        };

        const subagentId = await dir.spawn(cfg);
        const { randomUUID } = await import('node:crypto');
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
          return;
        }

        const reviewText =
          typeof result.result === 'string' ? result.result.trim() : JSON.stringify(result.result);

        if (reviewText) {
          await session.append({
            type: 'llm_response',
            ts: new Date().toISOString(),
            content: [{ type: 'text', text: reviewText }],
            stopReason: 'end_turn' as import('@wrongstack/core').StopReason,
            usage: { input: 0, output: 0 },
          });

          // ── autoFix mode dispatch ──────────────────────────────────
          // The review report is always sent to the mailbox so the leader
          // can see it regardless of mode. The type and follow-up action
          // depend on p.config.autoFix:
          //
          //   off  → type:result  — leader sees it, waits for user command
          //   ask  → type:ask     — leader prompts user for permission
          //   auto → type:result  — plus spawn a fix subagent immediately
          const autoFix = (agent.ctx.meta['chimeraAutoFix'] as string | undefined)
            ?? p.config.autoFix ?? 'off';
          const mailboxType = autoFix === 'ask' ? 'ask' : 'result';
          const subject =
            autoFix === 'ask'
              ? `🦂 Chimera review — ${p.files.length} file(s) changed. Shall I fix the findings?`
              : `🦂 Chimera review — ${p.files.length} file(s) changed`;

          try {
            await mailbox.send({
              from: 'chimera-review',
              to: '*',
              type: mailboxType,
              subject,
              body: reviewText.length > 8000
                ? reviewText.slice(0, 8000) + '\n\n…(truncated, full report in session transcript)'
                : reviewText,
              priority: 'normal',
            });
          } catch (mailErr) {
            console.error(
              JSON.stringify({
                level: 'error',
                event: 'execution.chimera_mailbox_failed',
                message: mailErr instanceof Error ? mailErr.message : String(mailErr),
                timestamp: new Date().toISOString(),
              }),
            );
          }

          // auto mode: spawn a fix subagent with the review + file list
          if (autoFix === 'auto' && reviewText.length > 0) {
            const fixTaskDesc = [
              `You are a fix agent. Apply the fixes requested in this review report.`,
              ``,
              `Repository: ${p.cwd}`,
              ``,
              `--- Review report ---`,
              reviewText.slice(0, 12_000),
              ``,
              `--- Changed files ---`,
              p.files.map((f) => `- ${f.path}`).join('\n'),
              ``,
              `Read each file, understand the issue, apply fixes using the edit tool.`,
              `After fixing, run the project's typecheck and linter to verify.`,
              `Do NOT remove or reorder existing code unless the bug requires it.`,
            ].join('\n');

            try {
              // Role-based model matrix resolution for the fix subagent too.
              // Falls through to the * default or leader model when no matrix
              // entry exists for the 'fixer' role. Generous budget because
              // auto-fixing may need to read, edit, lint, and verify across
              // multiple files in succession.
              const fixCfg: SubagentConfig = {
                name: 'chimera-fix',
                role: 'fixer',
                maxIterations: 60,
                maxToolCalls: 350,
                timeoutMs: 1_200_000,
              };
              const fixSubagentId = await dir.spawn(fixCfg);
              const fixTaskId = (await import('node:crypto')).randomUUID();
              await dir.assign({ id: fixTaskId, description: fixTaskDesc, subagentId: fixSubagentId });
              const fixResults = await dir.awaitTasks([fixTaskId]);
              const fixResult = fixResults[0];
              if (fixResult?.status === 'success') {
                await session.append({
                  type: 'llm_response',
                  ts: new Date().toISOString(),
                  content: [{ type: 'text', text: `Chimera fix subagent completed: ${fixResult.result}` }],
                  stopReason: 'end_turn' as import('@wrongstack/core').StopReason,
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
        // Subagent spawn/assign failed — log and ignore
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
      }
    })();
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
    // --prompt flag takes precedence: treat it like a positional query
    const promptFlag = typeof flags['prompt'] === 'string' ? flags['prompt'] : undefined;
    if (promptFlag) {
      positional.unshift(promptFlag);
    }
    // --goal / --ask boot directly into the TUI in goal/ask mode. The TUI is
    // the only surface with the steering + fleet panel + Esc-redirect wiring
    // that goal mode depends on, so if the user passed a goal but forgot
    // --tui, we flip --tui on for them. Single-shot positional invocation
    // still wins: `wstack --goal X "literal prompt"` runs the positional as
    // a normal single-shot (positional is non-empty), which is consistent
    // with --prompt's existing semantics.
    const goalFlag = typeof flags['goal'] === 'string' ? flags['goal'] : undefined;
    const askFlag = typeof flags['ask'] === 'string' ? flags['ask'] : undefined;
    if ((goalFlag || askFlag) && positional.length === 0 && !promptFlag) {
      flags.tui = true;
    }
    // Live fleet status line for the plain terminal. The TUI owns its own
    // per-agent surface (and Ink owns stdout), so only run this on the
    // non-TUI paths: single-shot, plain REPL, and webui-backed REPL.
    const enteringTui =
      !(positional.length > 0 || promptFlag) && !!flags.tui && flags['no-tui'] !== true;
    if (!enteringTui) {
      fleetStatusLine = new FleetStatusLine({ events, version: CLI_VERSION });
      fleetStatusLine.start();
    }
    if (positional.length > 0 || promptFlag) {
      code = await runSingleShotDispatch({
        agent,
        query: positional.join(' '),
        flags,
        tokenCounter,
        renderer,
      });
    } else if (flags.tui && !flags['no-tui'] && !flags.webui) {
      // --webui takes precedence over the TUI: both want exclusive ownership of
      // stdout, and the webui branch (below) runs the REPL + browser server. The
      // `!flags.webui` guard ensures a stray --tui (or a default) can't shadow it.
      // Switch from inline CLI prompts to event-driven confirmation.
      // Without this, the permission prompt writes to stdout and blocks
      // on stdin — both owned by Ink — making the prompt invisible and
      // the input deadlocked. After this call, tool.confirm_needed events
      // fire instead, which the TUI's ConfirmPrompt component handles.
      agent.disableInteractiveConfirmation();
      const { runTui } = (await import('@wrongstack/tui')) as {
        runTui: (opts: import('@wrongstack/tui').RunTuiOptions) => Promise<number>;
      };
      renderer.setSilent(true);

      // Shared mutable runtime state for extracted TUI sub-modules.
      // Phase B modules (coordinator setup, project switch) mutate these
      // fields through the shared object rather than closure capture.
      const state: TuiRuntimeState = {
        projectRoot,
        wpaths,
        activeSessionStore,
        activeRecoveryLock,
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
      // Last 3 chars of the active API key — shown in the TUI startup banner
      // so the operator can visually confirm which key is being used (e.g. "...abc").
      // Only 3 chars are shown: meaningful for key-pick verification, meaningless
      // for an attacker without the full key. The full key is never displayed or logged.
      // This is low risk but intentionally documented here so the design is clear.
      const banneredKeyTail =
        banneredKey && banneredKey.length >= 3 ? banneredKey.slice(-3) : undefined;

      // AutoPhase event forwarding — subscribes to PhaseOrchestrator events
      // on the main EventBus and forwards them to the TUI handler so the
      // PhaseMonitor/PhasePanel stay in sync with the running graph.
      const autoPhaseWiring = wireAutoPhase(events);
      const subscribeAutoPhase = autoPhaseWiring.subscribe;

      // Special exit code for project switch — triggers a clean wstack restart
      // in the target project directory after the TUI unmounts.
      // (Imported from boot/tui-project-spawn.ts — the spawn logic lives there.)

      // Stores the pending project switch info set by onProjectSelect (F1
      // picker) or onSwitchToSession (F10 sessions panel). Checked after
      // runTui returns PROJECT_SWITCH_EXIT_CODE to spawn the new wstack
      // process. `resumeSessionId` makes the new instance resume that
      // session (`--resume <id>`) instead of starting fresh.
      // (Lives on `state.pendingProjectSwitch` — set by TUI callbacks, read by handleProjectSwitchSpawn.)

      // ── AutonomousCoordinator: project-level multi-session coordination ─────────
      // The coordinator tracks goals, tasks, knowledge, and consensus across all
      // active sessions in the same project. Initialized lazily when the Director
      // becomes available so we have access to director.fleet for cross-session events.
      // Gated by features.autonomousCoordination (default true) — users who only use
      // the simpler Director/Fleet path can disable it to shrink the coordination
      // surface at runtime.
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
        const result = await switchProjectInPlaceExtracted(switchCtx, targetRoot, displayName);
        if (result === null) {
          // Update the function-scope recovery lock so cleanup clears the
          // switched-to project's lock, not the original one.
          currentRecoveryLock = state.activeRecoveryLock;
        }
        return result;
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

      try {
        code = await runTui({
          agent,
          events,
          slashRegistry,
          attachments,
          tokenCounter,
          visionAdapters,
          supportsVision,
          model: context.model,
          banner: !flags['no-banner'],
          queueStore,
          // Queue awareness: mirror the TUI's pending-message queue onto the
          // live Context so the agent loop can surface "messages are waiting"
          // at its next iteration boundary (see core/queued-messages.ts).
          onQueueChange: (items: string[]) => {
            setQueuedMessagesSnapshot(context, items);
          },
          // --mouse forces full mouse mode on; when absent, leave undefined so
          // run-tui can still enable it from the saved setting / WRONGSTACK_MOUSE.
          mouse: flags.mouse ? true : undefined,
          yolo: !!config.yolo,
          getYolo,
          onYolo,
          getAutonomy,
          // Next-task prediction (/next). Host owns the gating: returns [] when
          // the toggle is off or autonomy is self-driving, so the TUI can call
          // this unconditionally after a done turn. Display-only.
          predictNext: async (input: { userRequest: string; assistantSummary: string }) => {
            if (!getNextPredict?.()) return [];
            if ((getAutonomy?.() ?? 'off') !== 'off') return [];
            return predictNextTasks(
              { ...input, todos: context.todos },
              {
                provider: context.provider as never as PredictLLMProvider,
                model: context.model,
              },
            );
          },
          // Parse 💡 Next steps from assistant output and store them in the
          // shared suggestion store so `/next 1`, `/next 1 2 3` work without
          // requiring `/suggest` first. Called unconditionally on every done
          // turn. The live todo list is passed through so we suppress
          // <nextsteps> while the in-flight todo loop is still in progress
          // — finishing the open todos comes before offering new prompt
          // options.
          onSuggestionsParsed: (finalText: string) => {
            const parsed = parseSuggestionsFromOutput(finalText, context.todos);
            setSuggestions(parsed ?? []);
          },
          // Retrieve current suggestions for next-steps auto-submit countdown.
          getSuggestions: () => getSuggestions?.() ?? [],
          // Store parsed next steps so the /next command and auto-submit countdown
          // can access them (entry.tsx parses from rendered messages).
          setSuggestions,
          getEternalEngine,
          getSddRun,
          onSddLifecycle,
          subscribeEternalIteration,
          subscribeEternalStage,
          subscribeAutoPhase,
          appVersion: CLI_VERSION,
          provider: config.provider,
          family: banneredFamily,
          keyTail: banneredKeyTail,
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
          // Terminal title animation: read from config (default on).
          titleAnimation:
            ((config.autonomy as Record<string, unknown> | undefined)?.[
              'terminalTitleAnimation'
            ] as boolean) ?? true,
          // Completion chime: terminal bell when agent finishes.
          chime:
            ((config.autonomy as Record<string, unknown> | undefined)?.['chime'] as boolean) ??
            false,
          // Normal exit.
          confirmExit:
            ((config.autonomy as Record<string, unknown> | undefined)?.[
              'confirmExit'
            ] as boolean) ?? true,
          director,
          getDirector,
          fleetRoster,
          // ── AutonomousCoordinator: project-level multi-session coordination ─────────
          // The coordinator tracks goals, tasks, knowledge, and consensus across all
          // active sessions in the same project. It runs independently of the leader
          // agent and is accessible to any session in the project via the GlobalMailbox.
          getAutonomousCoordinator: () => ensureAutonomousCoordinator(),
          subscribeCoordinatorEvents: (fn: (event: CoordinatorEvent) => void) => {
            coordinatorEvents.add(fn);
            return () => {
              coordinatorEvents.delete(fn);
            };
          },
          onCoordinatorStart: (goal?: string) => {
            const coordinator = ensureAutonomousCoordinator();
            if (!coordinator) {
              console.error(
                JSON.stringify({
                  level: 'error',
                  event: 'coordinator.not_ready',
                  message: 'no director available',
                  timestamp: new Date().toISOString(),
                }),
              );
              return;
            }
            if (state.coordinatorRun) return;
            state.coordinatorRun = coordinator
              .run({ goal: goal ?? 'Improve the codebase', runUntilComplete: true })
              .then(() => undefined)
              .catch((err) => {
                console.error(
                  JSON.stringify({
                    level: 'error',
                    event: 'coordinator.run_failed',
                    message: err instanceof Error ? err.message : String(err),
                    timestamp: new Date().toISOString(),
                  }),
                );
              })
              .finally(() => {
                state.coordinatorRun = null;
              });
          },
          onCoordinatorStop: () => {
            state.autonomousCoordinator?.stop();
          },
          onCoordinatorTasks: async () => {
            const coordinator = ensureAutonomousCoordinator();
            if (!coordinator) return null;
            await coordinator.graph.load();
            return coordinator.auction.getPendingTasks().map((task) => ({
              id: task.id,
              title: task.title,
              priority: task.priority,
              tags: task.tags,
            }));
          },
          onCoordinatorClaim: async (taskId: string) => {
            const coordinator = ensureAutonomousCoordinator();
            if (!coordinator) return 'No coordinator is active.';
            await coordinator.graph.load();
            const goal = coordinator.graph.get(taskId) as
              | import('@wrongstack/core').GoalNode
              | undefined;
            if (goal?.type !== 'goal') {
              return `Task ${taskId.slice(0, 8)} not found in the coordinator graph.`;
            }
            if (goal.status !== 'pending') {
              return `Task ${taskId.slice(0, 8)} is ${goal.status}, not claimable.`;
            }
            const ok = await coordinator.auction.claim(
              taskId,
              `terminal@${context.session.id ?? 'unknown'}`,
              'Terminal worker',
            );
            if (!ok) {
              return `Task ${taskId.slice(0, 8)} could not be claimed (status changed?).`;
            }
            return { description: goal.description };
          },
          onCoordinatorComplete: async (taskId: string, result?: string) => {
            const coordinator = ensureAutonomousCoordinator();
            if (!coordinator) return 'No coordinator is active.';
            await coordinator.graph.load();
            const goal = coordinator.graph.get(taskId) as
              | import('@wrongstack/core').GoalNode
              | undefined;
            if (goal?.type !== 'goal') {
              return `Task ${taskId.slice(0, 8)} not found in the coordinator graph.`;
            }
            if (goal.status !== 'in_progress') {
              return `Task ${taskId.slice(0, 8)} is ${goal.status}, cannot complete.`;
            }
            await coordinator.reportTaskCompletion(
              taskId,
              result ?? 'Terminal worker completed the task',
            );
            return null;
          },
          onCoordinatorFail: async (taskId: string, error: string) => {
            const coordinator = ensureAutonomousCoordinator();
            if (!coordinator) return 'No coordinator is active.';
            await coordinator.graph.load();
            const goal = coordinator.graph.get(taskId) as
              | import('@wrongstack/core').GoalNode
              | undefined;
            if (goal?.type !== 'goal') {
              return `Task ${taskId.slice(0, 8)} not found in the coordinator graph.`;
            }
            if (goal.status !== 'in_progress') {
              return `Task ${taskId.slice(0, 8)} is ${goal.status}, cannot fail.`;
            }
            await coordinator.reportTaskFailure(taskId, error);
            return null;
          },
          onCoordinatorStatus: async () => {
            const coordinator = ensureAutonomousCoordinator();
            if (!coordinator) return null;
            await coordinator.syncFromGraph();
            const stats = coordinator.getStats();
            return {
              goals: {
                total: stats.goals.total,
                done: stats.goals.done,
                pending: stats.goals.pending,
                failed: stats.goals.failed,
              },
              dag: {
                running: stats.dag.running,
                ready: stats.dag.ready,
                done: stats.dag.done,
                failed: stats.dag.failed,
              },
              auction: {
                pending: stats.auction.pending,
                inProgress: stats.auction.in_progress,
              },
            };
          },
          // /clear: signal the TUI to wipe entries and reset fleet/leader stats
          // AND bump the context chip version — so the display reflects a
          // completely fresh session after the backend has been cleared.
          onClearHistory: (
            dispatch: (
              action:
                | { type: 'clearHistory' }
                | { type: 'resetContextChip' }
                | { type: 'streamReset' }
                | { type: 'toolStreamClear' },
            ) => void,
          ) => {
            dispatch({ type: 'clearHistory' });
            dispatch({ type: 'resetContextChip' });
            dispatch({ type: 'streamReset' });
            dispatch({ type: 'toolStreamClear' });
          },
          fleetStreamController,
          agentTranscripts,
          interruptController,
          enhanceController,
          getEnhancerReasoning,
          buildEnhancerProvider,
          getEnhanceFallbackRef,
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
                await modeStore.setActiveMode(id);
                const active = await modeStore.getActiveMode();
                return active?.name ?? null;
              }
            : undefined,
          registerDebugStreamCallback,
          restoreDebugStreamCallback,
          restoredMessages,
          restoredToolCalls,
          // ── Session resume support ──────────────────────────────────
          listSessions: async (limit = 20) => {
            if (!activeSessionStore) return [];
            const summaries = await activeSessionStore.list(limit);
            const currentId = agent.ctx.session?.id ?? session.id;
            return summaries.map((s) => ({
              id: s.id,
              title: s.title ?? '',
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
            resumeSession({ state, agent, tokenCounter, switchProviderAndModel }, sessionId),
          getProjectPickerItems: () => getProjectPickerItems(pickerCtx),
          onProjectSelect: (slug: string, kind: 'project' | 'action') =>
            onProjectSelect(pickerCtx, slug, kind),
          // `wrongstack quick` sets flags.quick — open the F3 agents monitor by default.
          initialAgentsMonitorOpen: !!flags.quick,
          tokenSavingMode: normalizeTokenSavingTier(config.features.tokenSavingMode),
          toolCount: agent.tools.list().length,
          onPanelOpen,
          memoryStore,
        } as never as import('@wrongstack/tui').RunTuiOptions);

        // After TUI exits with PROJECT_SWITCH_EXIT_CODE, spawn wstack in the new project.
        // This replaces the old behavior of spawning mid-session (which left the TUI
        // running and corrupted the terminal state).
        const spawnResult = await handleProjectSwitchSpawn({
          code,
          pendingProjectSwitch: state.pendingProjectSwitch,
        });
        if (spawnResult !== null) return spawnResult;
      } finally {
        renderer.setSilent(false);
        // Cleanup: stop Director lifecycle listener so the coordinator no-op guard fires.
        offDirectorSpawned();
      }
    } else if (flags.webui) {
      code = await runWebUIDispatch({
        agent,
        events,
        session,
        config,
        flags,
        projectRoot,
        globalConfigPath: wpaths.globalConfig,
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
        activeRecoveryLock,
        onModelContextResolved,
        sddSubagentFactory,
        ...(sddSubagentFactory
          ? {
              onKanbanDispatch: async (description, spawnOpts) => {
                const subagentId = `kanban-${randomUUID().slice(0, 8)}`;
                const taskId = randomUUID();
                const name = spawnOpts?.name ?? 'kanban-agent';
                let resolvedProvider = spawnOpts?.provider;
                let resolvedModel = spawnOpts?.model;
                let resolvedFallbackModels = spawnOpts?.fallbackModels;
                if (spawnOpts?.fallbackProfile) {
                  const chain = fallbackProfileChain(config, spawnOpts.fallbackProfile);
                  const primary = chain[0] ? parseModelRef(chain[0]) : undefined;
                  if (primary?.model) {
                    resolvedProvider = primary.provider ?? config.provider;
                    resolvedModel = primary.model;
                    resolvedFallbackModels = spawnOpts.fallbackModels ?? chain.slice(1);
                  }
                }
                let agentDescription = description;
                if (spawnOpts?.skills?.length && skillLoader) {
                  const loaded = await Promise.all(
                    spawnOpts.skills.map(async (skillName) => {
                      const manifest = await skillLoader.find(skillName);
                      if (!manifest) throw new Error(`Kanban skill not found: ${skillName}`);
                      const body = await skillLoader.readBody(skillName);
                      return `## Required skill: ${skillName}\n\n${body}`;
                    }),
                  );
                  agentDescription = `${description}\n\n# Required agentic skill instructions\n\n${loaded.join('\n\n')}`;
                }
                void (async () => {
                  const built = await sddSubagentFactory({
                    id: subagentId,
                    name,
                    role: 'kanban-agent',
                    prompt: agentDescription,
                    allowedCapabilities:
                      spawnOpts?.allowedCapabilities ?? WIDE_SUBAGENT_CAPABILITIES,
                    ...(resolvedProvider ? { provider: resolvedProvider } : {}),
                    ...(resolvedModel ? { model: resolvedModel } : {}),
                    ...(resolvedFallbackModels
                      ? { fallbackModels: resolvedFallbackModels }
                      : {}),
                    ...(spawnOpts?.tools ? { tools: spawnOpts.tools } : {}),
                  });
                  try {
                    const result = await built.agent.run(agentDescription);
                    await spawnOpts?.onDone?.({
                      status: result.status === 'done' ? 'completed' : 'failed',
                      result: result.finalText,
                      ...('error' in result && result.error?.message
                        ? { error: result.error.message }
                        : {}),
                    });
                  } catch (err) {
                    await spawnOpts?.onDone?.({
                      status: 'failed',
                      error: err instanceof Error ? err.message : String(err),
                    });
                    throw err;
                  } finally {
                    await built.dispose?.();
                  }
                })().catch((err) => {
                  events.emit('error', {
                    err: err instanceof Error ? err : new Error(String(err)),
                    phase: 'kanban.dispatch',
                  });
                });
                const tags: string[] = [];
                if (resolvedProvider) tags.push(resolvedProvider);
                if (resolvedModel) tags.push(resolvedModel);
                if (resolvedFallbackModels?.length) {
                  tags.push(`fallback=${resolvedFallbackModels.join(',')}`);
                }
                if (spawnOpts?.fallbackProfile) tags.push(`profile=${spawnOpts.fallbackProfile}`);
                if (spawnOpts?.skills?.length) tags.push(`skills=${spawnOpts.skills.join(',')}`);
                if (spawnOpts?.name) tags.push(`"${spawnOpts.name}"`);
                const tag = tags.length > 0 ? ` (${tags.join(' / ')})` : '';
                return `Spawned subagent ${subagentId}${tag} for task ${taskId}.`;
              },
            }
          : {}),
      });
    } else {
      // Headless run→kanban mirror: an SDD run started via `/sdd parallel` in
      // the REPL (no webui attached) still projects live into a kanban board on
      // disk (subscribes to sdd.board.snapshot on the shared bus). Broadcast is a
      // no-op — no browser here. The webui path has its own mirror, and the two
      // branches are mutually exclusive, so there is no double-mirror.
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
        onInterruptFleet: () => {
          // Mirror the slash /fleet kill path: remove (not just terminate)
          // every running/idle subagent so a Ctrl+C stops the whole fleet.
          // Resolved through getDirector so subagents spawned via the LAZY
          // director build (delegate tool in a non---director session) are
          // seen too — the static `director` is null there.
          const dir = getDirector?.() ?? director;
          if (!dir) return 0;
          let killed = 0;
          for (const sa of dir.status().subagents) {
            if (sa.status === 'running' || sa.status === 'idle') {
              try {
                void dir.remove(sa.id);
                killed++;
              } catch {
                /* best-effort */
              }
            }
          }
          return killed;
        },
        onAgentIterationComplete: (tokens) => {
          const dir = getDirector?.() ?? director;
          dir?.setLeaderContextPressure(tokens);
        },
        onCountdownTick,
        onDestroy,
      });
      } finally {
        headlessKanbanMirror?.dispose();
      }
    }
  } finally {
    offStorageRead();
    offStorageWrite();
    offStorageError();
    // Tear down the live fleet status line first so the scroll region is
    // restored before any end-of-session output prints.
    fleetStatusLine?.stop();
    // Stop the AutonomousCoordinator so its while-loop exits cleanly.
    // This sets running=false; the loop terminates at the next iteration check.
    onCoordinatorStopImpl?.();
    // stats.render is synchronous but can throw — isolate it so cleanup
    // always runs regardless.
    try {
      stats.render(renderer);
    } catch (_err) {
      /* best-effort */
    }
    await Promise.resolve(detachTodosCheckpoint?.()).catch(() => undefined);
    // Each cleanup step is independently guarded so a single failure
    // (e.g. MCP registry stop rejecting) cannot skip subsequent
    // durability steps (session_end, lock clear, reader close).
    await mcpRegistry.stopAll().catch((err) => {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'shutdown.mcp_stop_failed',
        message: `MCP registry stopAll failed: ${(err instanceof Error ? err.message : String(err))}`,
        timestamp: new Date().toISOString(),
      }));
    });
    // Use the CURRENT writer, not the one captured at startup — an in-app
    // resume (TUI/WebUI) swaps agent.ctx.session to the resumed session's
    // writer; session_end and close must land in THAT JSONL or the resumed
    // session never gets finalized (no summary sidecar, no index entry).
    const activeSession = agent.ctx.session ?? session;
    const pending = activeSession.pendingToolUses;
    await activeSession.append({
      type: 'session_end',
      ts: new Date().toISOString(),
      usage: tokenCounter.total(),
      pendingToolUses: pending.length > 0 ? pending : undefined,
    }).catch((err) => {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'shutdown.session_end_append_failed',
        message: `session_end append failed: ${(err instanceof Error ? err.message : String(err))}`,
        timestamp: new Date().toISOString(),
      }));
    });
    events.emit('session.ended', {
      id: activeSession.id,
      sessionId: activeSession.id,
      usage: tokenCounter.total(),
    });
    // Await chimera's in-flight work so the review result is written to the JSONL
    // before we close — without this, session.close() races against the subagent
    // and the review text is silently dropped because append returns early on closed.
    if (pendingChimeraWork) {
      await pendingChimeraWork.catch((err) => {
        console.warn(JSON.stringify({
          level: 'warn',
          event: 'shutdown.chimera_work_failed',
          message: `Pending chimera work failed: ${(err instanceof Error ? err.message : String(err))}`,
          timestamp: new Date().toISOString(),
        }));
      });
    }
    await activeSession.close().catch((err) => {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'shutdown.session_close_failed',
        message: `Session close failed: ${(err instanceof Error ? err.message : String(err))}`,
        timestamp: new Date().toISOString(),
      }));
    });
    await currentRecoveryLock
      .clear()
      .catch(() => undefined); /* best-effort: stale lock will be recovered on next startup */
    await reader.close().catch((err) => {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'shutdown.reader_close_failed',
        message: `Input reader close failed: ${(err instanceof Error ? err.message : String(err))}`,
        timestamp: new Date().toISOString(),
      }));
    });
  }
  return code;
}
