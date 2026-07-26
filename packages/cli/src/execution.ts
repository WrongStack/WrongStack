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
 *   boot/tui-goal-wiring.ts         — Goal event forwarding
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
  setQueuedMessagesSnapshot,
} from '@wrongstack/core/agent';
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
import { setupAutonomousCoordinator } from './boot/tui-coordinator-setup.js';
import { createTuiCoordinatorCallbacks } from './boot/tui-coordinator-callbacks.js';
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
  truncateAtCodePointBoundary,
} from './chimera-review-task.js';
import {
  applyChimeraReviewerReadOnlyPolicy,
  assignReviewerModelsRoundRobin,
  resolveReviewerFallbackModels,
} from './chimera-reviewer-policy.js';
import type { ExecuteDeps } from './execute-deps.js';
import { createKanbanDispatchHandler } from './execution-kanban-dispatch.js';
import { finalizeExecutionCleanup } from './execution-cleanup.js';
import { createReplFleetCallbacks } from './execution-repl-fleet-callbacks.js';
import { FleetStatusLine } from './fleet-statusline.js';

export type { LiveSettingsInput } from './live-settings-input.js';

import { resolveActiveApiKey } from './provider-config-utils.js';
import { runRepl } from './repl.js';
import { installStorageObservability } from './execution-storage-observability.js';
import { installChimeraCascadeHandler } from './execution-chimera-cascade.js';
import { waitForChimeraAskApproval } from './execution-chimera-ask.js';
import { createTuiNextStepCallbacks } from './execution-tui-next-step-callbacks.js';
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
      recoveryLock: initialRecoveryLock,
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
  const profileName = config.activeProfile ?? 'default';
  // Latest known update-check result, forwarded to the TUI so the banner
  // can render "(update available: v…)" next to the version chip without
  // re-running the npm registry lookup. A refresh during the session
  // (e.g. on project switch) is not currently modeled — the TUI mounts
  // its banner once at startup. Sourced from the CLI's preflight.
  const bootUpdateInfo: UpdateInfo | undefined = initialUpdateInfo;

  // ── Storage observability: relay storage.* events to stdout as structured JSON ──
  // The root traceId from the Context is the primary correlation ID. Storage
  // events emitted by FileSessionWriter (flush, close) carry their own traceId
  // (propagated from ContextInit) which we also included; events from the
  // DefaultSessionStore level (load, summary, compact) inherit it from context.
  const offStorageObservability = installStorageObservability(events, context.traceId);

  // Tracks the in-flight chimera subagent so finally can await it before session.close().
  // Without this, the fire-and-forget IIFE appends to a session whose handle is already closed.
  let pendingChimeraWork: Promise<void> | undefined;

  // ── Chimera post-session review: spawns subagent on chimera.review_needed ──
  events.onPattern('chimera.review_needed', (_event, payload) => {
    const p = payload as ChimeraReviewNeededPayload;
    const dir = director;
    if (!dir) {
      // Director not available — review skipped.
      return;
    }
    if (p.files.length === 0) return;

    // Store the promise so the finally block can await it before session.close().
    // events.emit('session.ended') fires synchronously, so this assignment
    // happens before the finally block checks pendingChimeraWork.
    pendingChimeraWork = (async () => {
      try {
        const taskDesc = buildChimeraReviewTaskDescription(p);

        // Role-based model matrix resolution: the Director.spawn() resolves
        // provider/model from the model matrix by role (→ phase → * → leader)
        // when no explicit model is set. This lets `/setmodel set reviewer <p>/<m>`
        // control the review model. Budget is generous because reviews regularly
        // need 15–19 iterations, 21+ tools, and 2+ minutes of wall time for
        // deep multi-file reading + git cross-referencing.
        // Trim + collapse empty provider/model so the subagent never spawns with empty credentials.
        const tProvider = config.provider?.trim() || undefined;
        const tModel = config.model?.trim() || undefined;
        const rawProvider = p.reviewFallbackModels
          ? p.config.provider?.trim() || undefined
          : tProvider;
        const rawModel = p.reviewFallbackModels ? p.config.model?.trim() || undefined : tModel;
        const baseProvider = rawProvider || tProvider || config.provider;
        const baseModel = rawModel || tModel || config.model;
        // Full rotation pool: configured primary + fallback chain. Round-robin
        // so concurrent chimera reviewers do not all open on the same model and
        // stampede one provider's rate limit.
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

        const subagentId = await dir.spawn(cfg);
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
          // Emit review_complete with empty text so the cascade listener
          // can record the outcome (it will no-op — no findings to parse).
          // This keeps the event-bus contract uniform across success/failure.
          events.emitCustom('chimera.review_complete', {
            bundle: p,
            reviewText: '',
            status: result?.status ?? 'unknown',
            cwd: p.cwd,
          } satisfies ChimeraReviewCompletePayload);
          return;
        }

        const reviewText =
          typeof result.result === 'string' ? result.result.trim() : JSON.stringify(result.result);

        // Emit review_complete so the auto-review plugin's cascade listener
        // can parse severity and decide whether to emit chimera.cascade_needed.
        // This fires synchronously within pendingChimeraWork, before any
        // autoFix branching, so the cascade path is orthogonal to fix mode.
        // The cascade listener only acts when bundle.cascadeOn is set (i.e.
        // the trigger was the auto-review plugin, not chimera-plugin or /review).
        events.emitCustom('chimera.review_complete', {
          bundle: p,
          reviewText,
          status: 'success',
          cwd: p.cwd,
        } satisfies ChimeraReviewCompletePayload);

        if (reviewText) {
          await session.append({
            type: 'llm_response',
            ts: new Date().toISOString(),
            content: [{ type: 'text', text: reviewText }],
            stopReason: 'end_turn' as StopReason,
            usage: { input: 0, output: 0 },
          });

          // ── autoFix mode dispatch ──────────────────────────────────
          // The review report is always sent to the mailbox so the leader
          // can see it regardless of mode. The type and follow-up action
          // depend on p.config.autoFix:
          //
          //   off  → type:result  — leader sees it, waits for user command
          //   ask  → type:ask     — leader prompted for permission; runtime
          //                         polls for a reply with 30s timeout;
          //                         on timeout/rejection falls back to off
          //   auto → type:result  — plus spawn a fix subagent immediately
          //
          // Cascade (security-scanner, bug-hunter) agents NEVER send
          // mailbox messages. Their results are appended directly to the
          // session transcript — the canonical delivery path for cascade
          // output.
          const autoFix =
            (agent.ctx.meta['chimeraAutoFix'] as string | undefined) ?? p.config.autoFix ?? 'off';
          const isAskMode = autoFix === 'ask';
          const mailboxType = isAskMode ? 'ask' : 'result';
          const subject = isAskMode
            ? `🦂 Chimera review — ${p.files.length} file(s) changed. Shall I fix the findings?`
            : `🦂 Chimera review — ${p.files.length} file(s) changed`;

          let leaderApproved = false;
          // ⚠️ Scope-sensitive guard: spawnedFix lives in the outer try-block
          // scope. If a future refactor wraps the poll-loop try-block in another
          // loop (e.g. retry the mailbox send), the boolean must be hoisted or
          // reset per iteration — the current single-entry invariant guarantees
          // safety.
          let spawnedFix = false;
          let askMailMsgId: string | undefined;

          // ── Best-effort leader presence check ─────────────────────
          // Before sending (ask mode only — polling depends on a live
          // leader), check whether any leader agent is currently online.
          // The mailbox message is still sent either way, but the warning
          // helps operators understand that delivery is deferred.
          // Agent status includes an `online` boolean (heartbeat within
          // threshold) — use that instead of a hand-rolled window.
          let leaderOnline = false;
          if (isAskMode) {
            try {
              const onlineAgents = await mailbox.getOnlineAgents();
              leaderOnline = onlineAgents.some(
                (a) => a.online && isMailboxLeader(a.agentId, a.role),
              );
            } catch (leaderCheckErr) {
              // should not happen; defensive
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
            // Auto mode: leader presence check is intentionally skipped —
            // the mailbox message is delivered regardless; the leader reads
            // it when they reconnect. Emit a debug log so operators have
            // the offline-deferred signal visible in the session transcript.
            console.debug(
              JSON.stringify({
                level: 'debug',
                event: 'execution.chimera_auto_no_presence_check',
                message:
                  'Auto mode: leader presence not checked — mailbox message delivered regardless',
                fileCount: p.files.length,
                autoFix,
                timestamp: new Date().toISOString(),
              }),
            );
          }

          try {
            // Resolve ask timeout early so the directive message can
            // reflect the actual configured value (not a hard-coded "30s").
            const askTimeoutRaw =
              (agent.ctx.meta['chimeraAskTimeoutMs'] as number | undefined) ?? 30_000;
            const ASK_TIMEOUT_MS = Number.isFinite(askTimeoutRaw)
              ? Math.max(0, askTimeoutRaw)
              : 30_000;
            // Build mailbox body with a directive prefix that tells the
            // leader to act on the chimera result proatively (not just
            // read it). The leader sees this via [MAILBOX] injection.
            const directive = isAskMode
              ? `LEADER ACTION REQUIRED: The Chimera review below found issues. Reply with "yes" to auto-fix, or "no" to skip (${ASK_TIMEOUT_MS / 1000}s timeout).`
              : 'LEADER ACTION REQUIRED: The Chimera review below found issues. Read the report and fix any Critical or High findings automatically using the edit tool. Verify with typecheck and linter.';
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

            // ── ask mode: poll for leader reply with bounded timeout ──
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

          // ── Wake-up signal for the leader ──────────────────────────
          // Emit an event so the TUI/REPL dispatch layer can react when
          // a chimera result arrives and the leader is idle. The mailbox
          // message itself is the durable cross-session wake-up signal.
          events.emitCustom('chimera.mailbox_delivered', {
            subject,
            autoFixMode: autoFix,
            fileCount: p.files.length,
            reviewLength: reviewText.length,
          });

          // ── Offline leader consumer ─────────────────────────────────
          // If no leader was online when the result was sent, send a
          // second high-priority companion message so the next leader
          // session sees the notification prominently and knows to check
          // the full mailbox for the chimera review result.
          // This is more durable than an in-process EventBus listener
          // (which dies with the session) — the mailbox persists in JSONL.
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

          // Spawn fix subagent when:
          //   auto mode  → always (immediate)
          //   ask mode   → only if leader replied with approval
          //   off mode   → never
          const shouldSpawnFix =
            !spawnedFix &&
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

  // ── Chimera cascade: spawns follow-up agents on chimera.cascade_needed ──
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
      // --webui takes precedence over the TUI: both want exclusive ownership of
      // stdout, and the webui branch (below) runs the REPL + browser server. The
      // `!flags.webui` guard ensures a stray --tui (or a default) can't shadow it.
      // Switch from inline CLI prompts to event-driven confirmation.
      // Without this, the permission prompt writes to stdout and blocks
      // on stdin — both owned by Ink — making the prompt invisible and
      // the input deadlocked. After this call, tool.confirm_needed events
      // fire instead, which the TUI's ConfirmPrompt component handles.
      agent.disableInteractiveConfirmation();

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

      // Goal event forwarding — subscribes to PhaseOrchestrator events
      // on the main EventBus and forwards them to the TUI handler so the
      // PhaseMonitor/PhasePanel stay in sync with the running graph.
      const goalWiring = wireGoal(events);
      const subscribeGoal = goalWiring.subscribe;

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

      // Claim both renderer streams after setup and before Ink starts. runTui()
      // suppresses direct console/stderr output synchronously when called.
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
          // Forward preflight's update-check to the banner so the
          // "(update available)" indicator renders next to the version
          // chip. Both fields are optional and undefined-safe: when
          // `bootUpdateInfo` is absent the banner simply renders just
          // `v<version>` with no trailing indicator.
          latestVersion: bootUpdateInfo?.latest,
          updateAvailable: bootUpdateInfo?.outdated,
          provider: config.provider,
          family: banneredFamily,
          keyTail: banneredKeyTail,
          profile: profileName,
          // Tilde-substitute the home directory so the banner shows
          // ~/.wrongstack/profiles/<name>/config.json — compact, portable,
          // and matches how users reference the path in docs and shells.
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
          ...createTuiCoordinatorCallbacks({
            state,
            context,
            coordinatorEvents,
            ensureAutonomousCoordinator,
          }),
          // /clear: signal the TUI to wipe entries and reset fleet/leader stats,
          // refresh the preserved banner from the live Context, and bump the
          // context chip version so every surface reflects the fresh session.
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
                // Persist the switch marker so a resumed session replays it.
                // Best-effort — never let session recording break the switch.
                const from = prev?.id ?? 'default';
                if (agent.ctx.session && from !== id) {
                  void agent.ctx.session
                    .append({ type: 'mode_changed', ts: new Date().toISOString(), from, to: id })
                    .catch(() => {
                      /* best-effort */
                    });
                }
                return active?.name ?? null;
              }
            : undefined,
          registerDebugStreamCallback,
          restoreDebugStreamCallback,
          restoredMessages,
          restoredToolCalls,
          restoredEvents,
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
            resumeSession(
              { state, agent, tokenCounter, switchProviderAndModel, events },
              sessionId,
            ),
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
        renderer.setTuiActive(false);
        // Cleanup: stop Director lifecycle listener so the coordinator no-op guard fires.
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
        activeRecoveryLock,
        agentTranscripts,
        onModelContextResolved,
        sddSubagentFactory,
        statusTracker,
        ...createKanbanDispatchHandler({ config, events, skillLoader, sddSubagentFactory }),
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
      recoveryLock: currentRecoveryLock,
      reader,
    });
  }
  return code;
}
