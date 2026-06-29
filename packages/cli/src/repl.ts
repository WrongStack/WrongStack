import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { toErrorMessage } from '@wrongstack/core/utils';
import type {
  Agent,
  AttachmentStore,
  GoalFile,
  SlashCommandRegistry,
  TokenCounter,
} from '@wrongstack/core';
import {
  color,
  estimateRequestTokensCalibrated,
  expectDefined,
  GlobalMailbox,
  goalFilePath,
  InputBuilder,
  loadGoal,
  resolveProjectDir,
  summarizeUsage,
  wstackGlobalRoot,
} from '@wrongstack/core';
import { readClipboardImage, routeImagesForModel, type VisionAdapters } from '@wrongstack/runtime';
import { parseNextSteps } from '@wrongstack/tui';
import { contextOverflowHint } from './context-overflow-diagnostic.js';
import { startCliHqConnection } from './hq-publisher.js';
import type { ReadlineInputReader } from './input-reader.js';
import { type PredictLLMProvider, predictNextTasks } from './next-task-predictor.js';
import type { TerminalRenderer } from './renderer.js';
import {
  advanceToNextTask,
  autoDetectTaskCompletion,
  getActiveSDDContext,
  getActiveSDDPhase,
  getCurrentExecutingContext,
  getTaskListText,
  getTaskProgress,
  renderTaskListWithProgress,
  trySaveImplementationPlan,
  trySaveSpecFromAIOutput,
  trySaveTasksFromAIOutput,
} from './slash-commands/sdd.js';
import { theme } from './theme.js';
import { fmtTok } from './utils.js';
import { CLI_VERSION } from './version.js';
import { setAutoSuggestions } from './slash-commands/suggestion-store.js';

/**
 * Extract "<next_steps>" or "💡 Next steps" suggestions from the agent's final output.
 * Delegated to parseNextSteps (permissive mode — accepts 💡, ##, plain, and <next_steps> headings).
 * Returns null when no suggestions are found.
 */
/**
 * Default ceiling on consecutive auto-proceed turns ('auto' autonomy mode)
 * between two manual inputs. Without it, a model that ends every reply with
 * a "Next steps" block drives the REPL in an unbounded self-feeding loop.
 * Overridden by `ReplOptions.autoProceedMaxIterations` (settable from the
 * settings panel; 0 means unlimited — the user's explicit choice).
 */
const DEFAULT_MAX_CONSECUTIVE_AUTO_PROCEED = 50;

export function parseSuggestionsFromOutput(finalText: string): string[] | null {
  const { texts, autoTexts } = parseNextSteps(finalText, false); // permissive: accept all heading variants
  // Store auto suggestions in the shared store for YOLO+auto autonomy mode
  if (autoTexts.length > 0) {
    setAutoSuggestions(autoTexts);
  }
  return texts.length > 0 ? texts : null;
}

/**
 * Extract only the auto="true" items from next_steps output.
 * Used by YOLO+auto autonomy mode.
 */
export function parseAutoSuggestionsFromOutput(finalText: string): string[] | null {
  const { autoTexts } = parseNextSteps(finalText, false); // permissive: accept all heading variants
  return autoTexts.length > 0 ? autoTexts : null;
}

export interface ReplOptions {
  agent: Agent;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  slashRegistry: SlashCommandRegistry;
  attachments: AttachmentStore;
  banner?: boolean | undefined;
  tokenCounter?: TokenCounter | undefined;
  visionAdapters?: VisionAdapters | undefined;
  /** Autonomy mode state getter. */
  getAutonomy?: (() => import('./slash-commands/autonomy.js').AutonomyMode) | undefined;
  /** Set autonomy mode (used by SIGINT handler to flip back to 'off'). */
  onAutonomy?: ((mode: import('./slash-commands/autonomy.js').AutonomyMode) => void) | undefined;
  /**
   * Whether next-task prediction is enabled. When true, the REPL runs a
   * lightweight single-shot prediction after each completed turn and shows
   * the likely next steps (display-only). Toggled via `/next`.
   */
  getNextPredict?: (() => boolean) | undefined;
  /**
   * Called after each agent turn with parsed "💡 Next steps" suggestions
   * extracted from the final response text. The host stores these so
   * `/next 1`, `/next 1 2 3` can select and execute them.
   * Passed `null` when no suggestions were found in the output.
   */
  onSuggestionsParsed?: ((suggestions: string[] | null) => void) | undefined;
  /**
   * Read the current suggestion list. Used by the auto-proceed loop to
   * check whether there are suggestions to feed when autonomy is 'auto'.
   */
  getSuggestions?: (() => string[]) | undefined;
  /**
   * Read the current auto suggestion list (items with auto="true" attribute).
   * Used by YOLO+auto autonomy mode.
   */
  getAutoSuggestions?: (() => string[]) | undefined;
  /**
   * YOLO mode getter. When true, auto="true" suggestions trigger auto-proceed.
   */
  getYolo?: (() => boolean) | undefined;
  /**
   * Autonomy next prompt template. Used to construct the prompt when auto-submitting
   * a next_steps item in YOLO+auto mode. Contains {{suggestion}} placeholder.
   */
  autonomyNextPrompt?: string | undefined;
  /**
   * Delay in milliseconds before auto-proceeding with the top suggestion
   * when autonomy mode is 'auto'. Default 45 seconds.
   */
  autoProceedDelayMs?: number | undefined;
  /**
   * Maximum auto-proceed iterations before stopping to prevent infinite
   * loops. Default 50. 0 means unlimited.
   */
  autoProceedMaxIterations?: number | undefined;
  /**
   * LLM validation gate called before starting the auto-proceed countdown.
   * Receives the top suggestion and the last agent output text. Should
   * return `true` if auto-proceeding is safe, `false` if user review is
   * needed. The countdown only starts when this returns `true`.
   */
  onValidateAutoProceed?:
    | ((suggestion: string, lastOutput: string) => Promise<boolean>)
    | undefined;
  /**
   * Access the eternal-autonomy engine. When autonomy mode is 'eternal'
   * the REPL skips reading user input and instead drives engine
   * iterations from this loop — so the engine and the REPL never compete
   * for the shared Context. Returns null until /autonomy eternal primes it.
   */
  getEternalEngine?: (() => import('@wrongstack/core').EternalAutonomyEngine | null) | undefined;
  /**
   * Access the parallel-eternal engine. When autonomy mode is 'eternal-parallel'
   * the REPL drives this engine instead of reading user input.
   * Returns null until /autonomy parallel primes it.
   */
  getParallelEngine?: (() => import('@wrongstack/core').ParallelEternalEngine | null) | undefined;
  /**
   * Access the active SDD parallel run's control surface (or null). A running
   * `/sdd parallel` blocks the prompt while it awaits completion, so this is the
   * only mid-run stop path from the REPL — the SIGINT handler calls `stop()`.
   */
  getSddRun?: (() => import('@wrongstack/core').SddRunControl | null) | undefined;
  /** Model-specific max context window (tokens). Used for the context bar in turn summaries. */
  effectiveMaxContext?: number | undefined;
  /** Live model-specific max context window. Prefer this over the startup snapshot when provided. */
  getEffectiveMaxContext?: (() => number | undefined) | undefined;
  /** Project / folder name shown in the banner. Usually `path.basename(projectRoot)`. */
  projectName?: string | undefined;
  /** Absolute project root — used to locate .wrongstack/goal.json for the goal banner. */
  projectRoot?: string | undefined;
  /** Full app config, used for HQ client publishing settings. */
  appConfig?: import('@wrongstack/core').Config | undefined;
  /** Live active session id for cross-surface client registration. */
  getSessionId?: (() => string | undefined) | undefined;
  /** Resolve current model vision support. Falls back to provider capability when omitted. */
  supportsVision?: (() => boolean | Promise<boolean>) | undefined;
  /** Skill loader for the skill generator wizard. */
  skillLoader?: import('@wrongstack/core').SkillLoader | undefined;
  /** Controller for the agents monitor overlay. */
  agentsMonitorController?:
    | {
        visible: boolean;
        setVisible: (visible: boolean) => void;
      }
    | undefined;
  /** Controller for fleet stream (subagent output to history). */
  fleetStreamController?:
    | {
        enabled: boolean;
        setEnabled: (enabled: boolean) => void;
      }
    | undefined;
  /**
   * Shared controller for the `/interrupt` slash command. The REPL installs
   * `abortLeader` here so the command can abort the active turn. Note: the REPL
   * prompt is blocked during a run, so `/interrupt` is only dispatched at the
   * prompt (where nothing is in flight) — Ctrl+C is the mid-run path.
   */
  interruptController?:
    | {
        abortLeader: () => boolean;
      }
    | undefined;
  /**
   * Stop every running subagent. Wired to the director so the first Ctrl+C (and
   * `/interrupt`) stops the fleet too, not just the leader. Returns the count
   * stopped. Undefined when no fleet/director is active.
   */
  onInterruptFleet?: (() => number) | undefined;
  /**
   * Called after each agent.run() iteration completes so the host can
   * report context pressure to the Director (for spawn pre-checks) or
   * other systems that track token usage across the session.
   */
  onAgentIterationComplete?: ((estimatedTokens: number) => void) | undefined;
  /**
   * Called every second during the auto-proceed countdown with the
   * remaining seconds until auto-proceed fires. Return true to abort
   * the countdown and switch to manual mode.
   */
  onCountdownTick?: ((remainingSeconds: number) => boolean | void) | undefined;
  /** Called when the REPL exits — use for cleanup such as removing event listeners. */
  onDestroy?: (() => void) | undefined;
}

export async function runRepl(opts: ReplOptions): Promise<number> {
  if (opts.banner !== false) printBanner(opts.renderer, opts.projectName);
  // Surface active goal + crash-recovery hint right under the banner so the
  // user doesn't have to run /goal status to remember what's in flight.
  await renderGoalBanner(opts);

  // Per-iteration abort controller — assigned each loop so a Ctrl+C that
  // cancels turn N doesn't leak into turn N+1. `activeCtrl` is updated
  // before each agent.run so the SIGINT handler can target it.
  let activeCtrl: AbortController | undefined;
  let interrupts = 0;
  // Install the leader-abort handler for the `/interrupt` slash command. The
  // closure reads the live `activeCtrl` each call. In the REPL a slash command
  // only dispatches at the prompt (input is blocked during a run), so this is
  // usually a no-op there — Ctrl+C is the mid-run path. Still wired for
  // completeness and parity with the other surfaces.
  if (opts.interruptController) {
    opts.interruptController.abortLeader = () => {
      if (activeCtrl) {
        activeCtrl.abort();
        return true;
      }
      return false;
    };
  }
  // Consecutive auto-proceed turns since the last manual input. Auto mode
  // feeds suggestion #1 back into the agent after every turn — a model that
  // emits "Next steps" on every reply would otherwise loop forever (and the
  // unsupervised loop has burned real sessions: it spins at full speed when
  // autoProceedDelayMs is 0). Manual input resets the counter.
  let autoIterCount = 0;
  let autoCapWarned = false;
  let exiting = false;
  const onSigint = () => {
    interrupts++;
    if (interrupts >= 2) {
      opts.renderer.writeWarning('Exiting.');
      exiting = true;
      return;
    }
    // In eternal or parallel mode, the first Ctrl+C should stop the engine —
    // aborting the in-flight agent.run and flipping autonomy back to 'off'
    // so the outer for-loop returns to reading user input on the next tick.
    if (opts.getAutonomy?.() === 'eternal' || opts.getAutonomy?.() === 'eternal-parallel') {
      opts.getEternalEngine?.()?.stop();
      opts.getParallelEngine?.()?.stop();
      opts.onAutonomy?.('off');
      opts.renderer.writeWarning('Engine stop requested. Press Ctrl+C again to exit.');
      interrupts = 0;
      return;
    }
    // A `/sdd parallel` run blocks the REPL prompt while it awaits completion, so
    // `/sdd stop` can never be typed mid-run — Ctrl+C is the only stop path. The
    // run has its own coordinator (not the autonomy engines above), so it is
    // unreachable from the generic activeCtrl branch; stop it explicitly here.
    // stop() aborts the in-flight workers; the run drains and the prompt returns.
    const sddRun = opts.getSddRun?.();
    if (sddRun?.isRunning()) {
      sddRun.stop();
      opts.renderer.writeWarning('SDD run stop requested. Press Ctrl+C again to exit.');
      interrupts = 0;
      return;
    }
    if (activeCtrl) {
      activeCtrl.abort();
      // Stop subagents too — "interrupt" means stop everything, not just the
      // leader. Without this the fleet keeps running on the old direction and
      // finishes minutes later. Matches the TUI's ESC-interrupt behavior.
      const killed = opts.onInterruptFleet?.() ?? 0;
      opts.renderer.writeWarning(
        killed > 0
          ? `Iteration cancelled · stopped ${killed} subagent${killed === 1 ? '' : 's'}. Press Ctrl+C again to exit.`
          : 'Iteration cancelled. Press Ctrl+C again to exit.',
      );
    } else {
      opts.renderer.writeWarning('Press Ctrl+C again to exit.');
    }
  };
  process.on('SIGINT', onSigint);

  // ── Register REPL as a client in the shared mailbox ──────────────────────────
  // This lets other REPL/TUI/WebUI instances on the same project know this
  // REPL is running, even when no agents are active.
  const replProjectRoot = opts.projectRoot ?? process.cwd();
  const projectDir = resolveProjectDir(replProjectRoot, wstackGlobalRoot());
  const clientId = `repl@${crypto.randomUUID().slice(0, 8)}`;
  const hqConnection = startCliHqConnection({ clientKind: 'repl', projectRoot: replProjectRoot, projectName: path.basename(replProjectRoot), appConfig: opts.appConfig });
  const clientMailbox = new GlobalMailbox(projectDir, undefined, () => hqConnection.getPublisher());
  let clientHeartbeat: ReturnType<typeof setInterval> | undefined;
  clientMailbox
    .registerClient({
      clientId,
      sessionId: opts.getSessionId?.() ?? replProjectRoot,
      name: `REPL [${path.basename(replProjectRoot)}]`,
      source: 'repl',
      pid: process.pid,
    })
    .then(() => {
      clientHeartbeat = setInterval(() => {
        clientMailbox.clientHeartbeat({ clientId, sessionId: opts.getSessionId?.() ?? replProjectRoot }).catch(() => {
          // best-effort — if the registry is gone, don't spam errors
        });
      }, 15_000);
    })
    .catch(() => {
      // best-effort — if another instance has the lock, skip registration
    });

  const builder = new InputBuilder({ store: opts.attachments });

  // Wrap the entire loop so SIGINT and reader teardown run on every exit
  // path — exceptions, EOF, breakouts. Previously a throw between `on`
  // and the final `off` left the listener installed across REPL restarts.
  try {
    for (;;) {
      if (exiting) break;
      // ── Eternal autonomy: drive the engine instead of reading input. ──
      // While autonomy mode is 'eternal' we own the REPL turn — the engine
      // generates its own directive and runs `agent.run` for us. Stop is
      // signaled by the engine flipping to 'stopped' (via /autonomy stop or
      // SIGINT). On exit from this branch the for-loop continues normally
      // and the next iteration reads user input again.
      if (opts.getAutonomy?.() === 'eternal') {
        const engine = opts.getEternalEngine?.();
        if (!engine) {
          opts.renderer.writeWarning('Eternal mode set but no engine wired — falling back to off.');
          // Best-effort: nothing more to do here; the engine controller
          // was supposed to be primed by /autonomy eternal.
        } else {
          // Snapshot iteration counter before/after so the log line tells
          // the user where they are in the goal lifetime — useful when
          // the loop runs for hours and the journal scrolls off screen.
          const beforeGoal = await loadGoalSafe(opts);
          const beforeIter = beforeGoal?.iterations ?? 0;
          opts.renderer.write(color.dim(`\n  ↳ [eternal #${beforeIter + 1}] running iteration…\n`));
          interrupts = 0;
          try {
            const ok = await engine.runOneIteration();
            const afterGoal = await loadGoalSafe(opts);
            const last = afterGoal?.journal[afterGoal.journal.length - 1];
            if (!ok && !last) {
              opts.renderer.write(color.dim('  ↳ [eternal] iteration produced no progress.\n'));
            } else if (last) {
              const mark =
                last.status === 'success'
                  ? color.green('✓')
                  : last.status === 'failure'
                    ? color.red('✗')
                    : color.amber('⊘');
              const tail = last.note ? color.dim(` — ${last.note.slice(0, 80)}`) : '';
              opts.renderer.write(
                `  ${mark} ${color.dim(`#${last.iteration}`)} ${color.dim(`[${last.source}]`)} ${last.task}${tail}\n`,
              );
            }
            // Check if the engine stopped because the goal completed.
            // The engine calls onEternalStop internally, which calls stop(),
            // but the REPL needs to flip autonomy mode so the loop exits
            // eternal mode and returns to reading user input.
            if (engine.currentState === 'stopped') {
              const goal = await loadGoalSafe(opts);
              if (goal?.goalState === 'completed') {
                const u = goal.journal.length > 0 ? summarizeUsage(goal) : null;
                const costLine =
                  u && u.iterationsWithUsage > 0
                    ? color.dim(
                        ` — ${u.totalCostUsd.toFixed(4)} · ${u.totalInputTokens} in / ${u.totalOutputTokens} out · ${goal.iterations} iterations`,
                      )
                    : goal.iterations > 0
                      ? color.dim(` — ${goal.iterations} iterations`)
                      : '';
                opts.renderer.write(
                  color.green(`\n  🎯 Goal completed!${costLine}\n\n`) +
                    color.dim('  Goal cleared. Use /goal set <mission> to create a new goal.\n'),
                );
                // Auto-clear the goal file so the completed goal doesn't
                // linger across restarts. The goal's journal is already
                // in the session log.
                if (opts.projectRoot) {
                  try {
                    const { unlink } = await import('node:fs/promises');
                    await unlink(goalFilePath(opts.projectRoot));
                  } catch {
                    // best-effort — file may already be gone
                  }
                }
              }
              opts.onAutonomy?.('off');
              continue;
            }
          } catch (err) {
            opts.renderer.writeError(
              `[eternal] ${toErrorMessage(err)}`,
            );
          }
          // Yield to the event loop so a SIGINT delivered during this
          // iteration can be processed before the next one fires.
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
      } else if (opts.getAutonomy?.() === 'eternal-parallel') {
        const engine = opts.getParallelEngine?.();
        if (!engine) {
          opts.renderer.writeWarning(
            'Parallel mode set but no engine wired — falling back to off.',
          );
        } else {
          const beforeGoal = await loadGoalSafe(opts);
          const beforeIter = beforeGoal?.iterations ?? 0;

          // Show subagent stats before launching
          const coord = engine.getCoordinator();
          if (coord) {
            const stats = coord.getStats();
            opts.renderer.write(
              color.dim(
                `  ┌─ Fleet: ${stats.running} running, ${stats.idle} idle, ${stats.pending} pending, ${stats.completed} done`,
              ) + '\n',
            );
          }

          opts.renderer.write(
            color.magenta(`  ↳ [parallel #${beforeIter + 1}] launching fan-out…\n`),
          );
          interrupts = 0;
          try {
            await engine.runOneIteration();
            const afterGoal = await loadGoalSafe(opts);
            const last = afterGoal?.journal[afterGoal.journal.length - 1];

            // Show results with subagent stats
            if (coord) {
              const stats = coord.getStats();
              opts.renderer.write(
                color.dim(
                  `  └─ Fleet: ${stats.running} running, ${stats.idle} idle, ${stats.completed} done\n`,
                ),
              );
            }

            if (last) {
              const mark =
                last.status === 'success'
                  ? color.green('✓')
                  : last.status === 'failure'
                    ? color.red('✗')
                    : color.amber('⊘');
              const tail = last.note ? color.dim(` — ${last.note.slice(0, 80)}`) : '';
              opts.renderer.write(
                `  ${mark} ${color.dim(`#${last.iteration}`)} ${color.dim(`[${last.source}]`)} ${last.task}${tail}\n`,
              );
            }
            // Exit parallel mode if the engine stopped (goal completed or user stopped).
            if (engine.currentState === 'stopped') {
              const goal = await loadGoalSafe(opts);
              if (goal?.goalState === 'completed') {
                const u = goal.journal.length > 0 ? summarizeUsage(goal) : null;
                const costLine =
                  u && u.iterationsWithUsage > 0
                    ? color.dim(
                        ` — ${u.totalCostUsd.toFixed(4)} · ${u.totalInputTokens} in / ${u.totalOutputTokens} out · ${goal.iterations} iterations`,
                      )
                    : goal.iterations > 0
                      ? color.dim(` — ${goal.iterations} iterations`)
                      : '';
                opts.renderer.write(
                  color.green(`\n  🎯 Goal completed!${costLine}\n\n`) +
                    color.dim('  Goal cleared. Use /goal set <mission> to create a new goal.\n'),
                );
                // Auto-clear the goal file so the completed goal doesn't
                // linger across restarts. The goal's journal is already
                // in the session log.
                if (opts.projectRoot) {
                  try {
                    const { unlink } = await import('node:fs/promises');
                    await unlink(goalFilePath(opts.projectRoot));
                  } catch {
                    // best-effort — file may already be gone
                  }
                }
              }
              opts.onAutonomy?.('off');
              continue;
            }
          } catch (err) {
            opts.renderer.writeError(
              `[parallel] ${toErrorMessage(err)}`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
      }

      // ── Auto-proceed / suggest: autonomy-driven next-step flow ──
      // After every agent turn, suggestions are parsed and stored in
      // currentSuggestions via onSuggestionsParsed.  Here at the top of
      // the loop (before reading user input) we check the autonomy mode:
      //
      //   'auto'    — brief cooldown (runs compaction), then auto-feed
      //               suggestion#1. No validation gate, no hard cap.
      //   'suggest' — display suggestions prominently, wait for user input
      //
      // Both modes stop when suggestions are exhausted.  Ctrl+C interrupts
      // the cooldown (reuses the existing activeCtrl SIGINT pattern).
      {
        const mode = opts.getAutonomy?.() ?? 'off';
        const suggestions = opts.getSuggestions?.() ?? [];

        // ── 'suggest' mode: display-only ────────────────────────────
        if (mode === 'suggest' && suggestions.length > 0) {
          const lines = suggestions.map((s, i) => `  ${color.bold(`${i + 1}.`)} ${color.dim(s)}`);
          opts.renderer.write(
            `\n${color.cyan('  💡 Suggested next steps')}  ${color.dim('(use /next 1, /next 2, or /next 1 2 3)')}\n${lines.join('\n')}\n\n`,
          );
        }

        // ── 'auto' mode: brief cooldown → feed directly ────────────
        if (mode === 'auto' && suggestions.length > 0) {
          // The cap pauses the loop but NEVER flips autonomy off — the mode
          // is the user's setting; only the user changes it.
          const maxAuto = opts.autoProceedMaxIterations ?? DEFAULT_MAX_CONSECUTIVE_AUTO_PROCEED;
          if (maxAuto > 0 && autoIterCount >= maxAuto) {
            if (!autoCapWarned) {
              autoCapWarned = true;
              opts.renderer.writeWarning(
                `Auto-proceed paused after ${maxAuto} consecutive automatic turns — ` +
                  'enter input to continue (resets the counter). Autonomy stays on.',
              );
            }
            // Fall through to the input read below instead of looping.
          } else {
            // YOLO+auto mode: use auto suggestions (items with auto="true" attribute)
            // and apply the autonomy_next prompt template
            const isYolo = opts.getYolo?.() ?? false;
            const autoSuggestions = opts.getAutoSuggestions?.() ?? [];
            const useAutoSuggestions = isYolo && autoSuggestions.length > 0;

            const top = useAutoSuggestions ? autoSuggestions[0] ?? '' : suggestions[0] ?? '';
            const delay = opts.autoProceedDelayMs ?? 1_000;
            const ctrl = new AbortController();
            activeCtrl = ctrl;
            try {
              autoIterCount++;
              // For YOLO+auto, apply the autonomy_next prompt template
              const promptToFeed = useAutoSuggestions && opts.autonomyNextPrompt
                ? opts.autonomyNextPrompt.replace('{{suggestion}}', top)
                : top;
              await runAutoProceed(opts, promptToFeed, delay, ctrl);
            } finally {
              activeCtrl = undefined;
            }
            continue;
          }
        }
      }

      let raw: string;
      try {
        raw = await readPossiblyMultiline(opts);
      } catch {
        break; // EOF (Ctrl+D)
      }
      const trimmed = raw.trim();
      if (!trimmed) {
        interrupts = 0;
        continue;
      }
      interrupts = 0;
      // Manual input re-arms auto-proceed.
      autoIterCount = 0;
      autoCapWarned = false;

      // Plain `q` quits immediately without needing a slash.
      if (trimmed === 'q') {
        opts.renderer.write(color.dim('  Goodbye!\n'));
        break;
      }

      // `cd` and `wd` shortcuts → dispatch to /working_dir
      if (trimmed === 'wd' || trimmed.startsWith('cd ')) {
        const args = trimmed.startsWith('cd ') ? trimmed.slice(3).trim() : '';
        try {
          const res = await opts.slashRegistry.dispatch(`/working_dir ${args}`, opts.agent.ctx);
          if (res?.message) opts.renderer.write(`${res.message}\n`);
        } catch (err) {
          opts.renderer.writeError(toErrorMessage(err));
        }
        continue;
      }

      if (trimmed === '/image' || trimmed === '/paste-image' || raw === '\x1bv') {
        await pasteClipboardImage(builder, opts);
        continue;
      }

      if (trimmed.startsWith('/')) {
        try {
          const res = await opts.slashRegistry.dispatch(trimmed, opts.agent.ctx);
          if (res?.message) opts.renderer.write(`${res.message}\n`);
          if (res?.exit) break;

          // ── runText: Auto-trigger AI after slash command ─────────────────
          // When a slash command returns runText (e.g. /sdd new, /sdd approve),
          // automatically send it to the AI agent so the conversation continues
          // without the user having to type anything extra.
          if (res?.runText) {
            const runBlocks = [{ type: 'text' as const, text: res.runText }];
            const runCtrl = new AbortController();
            activeCtrl = runCtrl;
            try {
              const runResult = await opts.agent.run(runBlocks, { signal: runCtrl.signal });
              opts.onAgentIterationComplete?.(
                estimateRequestTokensCalibrated(
                  opts.agent.ctx.messages,
                  opts.agent.ctx.systemPrompt,
                  opts.agent.ctx.tools ?? [],
                ).total,
              );
              if (runResult.status === 'done' && runResult.finalText) {
                // SDD auto-detection: spec, implementation plan, tasks
                const specSaved = await trySaveSpecFromAIOutput(runResult.finalText);
                if (specSaved) {
                  opts.renderer.write(
                    `\n${color.cyan('  ✓ Spec detected and saved! Use /sdd approve to continue.')}\n`,
                  );
                }
                const planSaved = trySaveImplementationPlan(runResult.finalText);
                if (planSaved) {
                  opts.renderer.write(`\n${color.cyan('  ✓ Implementation plan saved!')}\n`);
                }
                const tasksSaved = await trySaveTasksFromAIOutput(runResult.finalText);
                if (tasksSaved) {
                  const progress = getTaskProgress();
                  const count = progress?.total ?? 0;
                  opts.renderer.write(
                    `\n${color.cyan(`  ✓ ${count} tasks detected and saved! Use /sdd approve to execute.`)}\n`,
                  );
                }
                // Auto-detect task completion during execution phase
                const sddPhase = getActiveSDDPhase();
                if (sddPhase === 'executing') {
                  const autoCompleted = autoDetectTaskCompletion(runResult.finalText);
                  if (autoCompleted > 0) {
                    const progress = getTaskProgress();
                    if (progress) {
                      opts.renderer.write(
                        `\n${color.cyan(`  ✓ ${autoCompleted} task(s) auto-completed! Progress: ${progress.completed}/${progress.total} (${progress.percentComplete}%)`)}\n`,
                      );
                      // Show live task list after auto-completion
                      const taskList = renderTaskListWithProgress();
                      if (taskList) {
                        opts.renderer.write(`\n${color.dim(taskList)}\n`);
                      }
                    }
                  } else {
                    // Still show task list even if nothing was auto-completed
                    const taskList = renderTaskListWithProgress();
                    if (taskList) {
                      opts.renderer.write(`\n${color.dim(taskList)}\n`);
                    }
                  }
                }

                // ── Suggestion auto-parsing (from runText-triggered turn) ──
                // When a slash command like /next triggers an agent turn,
                // parse "💡 Next steps" from the agent's output so
                // subsequent /next 1 calls use the latest suggestions,
                // not stale ones from a prior /suggest.
                if (opts.onSuggestionsParsed) {
                  const parsed = parseSuggestionsFromOutput(runResult.finalText);
                  opts.onSuggestionsParsed(parsed);
                }
              }
            } catch (_runErr) {
              // Non-fatal — user can continue manually
              opts.renderer.writeWarning('AI auto-trigger failed. You can continue manually.');
            }
          }
        } catch (err) {
          opts.renderer.writeError(toErrorMessage(err));
        }
        continue;
      }

      // Route through InputBuilder so big pastes collapse to placeholders.
      const ph = await builder.appendPaste(raw);
      if (ph) {
        const lineCount = raw.split('\n').length;
        opts.renderer.write(color.dim(`  ↳ ${ph} (${lineCount} lines)\n`));
      }
      const blocks = await builder.submit();

      // ── SDD Session Integration ─────────────────────────────────────────
      // When an SDD session is active, inject the session context so the AI
      // knows to ask questions, generate specs, etc.
      const sddContext = getActiveSDDContext();
      const taskList = getTaskListText();
      const taskProgress = getTaskProgress();
      const sddPhase = getActiveSDDPhase();

      let sddPrefix = '';
      if (sddContext) {
        sddPrefix = `[SDD SESSION ACTIVE]\n${sddContext}`;
        // During executing phase: tell AI exactly which task it's working on
        if (sddPhase === 'executing') {
          const currentCtx = getCurrentExecutingContext();
          if (currentCtx) {
            sddPrefix += `\n\n${currentCtx}`;
          }
        }
        if (taskList) {
          sddPrefix += `\n\n**Current Task List:**\n${taskList}`;
        }
        if (taskProgress && taskProgress.total > 0) {
          sddPrefix += `\n**Progress:** ${taskProgress.completed}/${taskProgress.total} (${taskProgress.percentComplete}%)`;
        }
        if (sddPhase === 'executing' && taskProgress && taskProgress.percentComplete === 100) {
          sddPrefix += '\n\n**All tasks completed! Provide a summary of everything implemented.**';
        }
        sddPrefix += '\n\n---\nUser message:\n';
      }

      const effectiveBlocks = sddPrefix
        ? [{ type: 'text' as const, text: sddPrefix }, ...blocks]
        : blocks;

      const runCtrl = new AbortController();
      activeCtrl = runCtrl;
      try {
        const startedAt = Date.now();
        const before = opts.tokenCounter?.total();
        const costBefore = opts.tokenCounter?.estimateCost().total ?? 0;
        const routed = effectiveBlocks.some((block) => block.type === 'image')
          ? await routeImagesForModel(effectiveBlocks, {
              supportsVision: opts.supportsVision
                ? await opts.supportsVision()
                : opts.agent.ctx.provider.capabilities.vision,
              adapters: opts.visionAdapters ?? [],
              ctx: opts.agent.ctx,
              signal: runCtrl.signal,
              providerId: opts.agent.ctx.provider.id,
              model: opts.agent.ctx.model,
            })
          : { blocks: effectiveBlocks, route: 'none' as const, convertedImages: 0 };
        if (routed.route === 'adapter') {
          opts.renderer.write(
            color.dim(
              `  ↳ image analyzed via ${routed.adapterName ?? 'vision adapter'} (${routed.convertedImages} image${routed.convertedImages === 1 ? '' : 's'})\n`,
            ),
          );
        }
        const result = await opts.agent.run(routed.blocks, { signal: runCtrl.signal });
        // Report context pressure to the Director (for spawn pre-checks) and
        // update the calibration state so the next estimate is more accurate.
        opts.onAgentIterationComplete?.(
          estimateRequestTokensCalibrated(
            opts.agent.ctx.messages,
            opts.agent.ctx.systemPrompt,
            opts.agent.ctx.tools ?? [],
          ).total,
        );
        if (result.status === 'aborted') {
          opts.renderer.writeWarning('Aborted.');
        } else if (result.status === 'failed') {
          const err = result.error;
          if (err) {
            const tag = err.recoverable ? ' (recoverable)' : '';
            opts.renderer.writeError(`Failed [${err.severity}]${tag}: ${err.describe()}`);
            const hint = contextOverflowHint(err);
            if (hint) opts.renderer.writeWarning(hint);
          } else {
            opts.renderer.writeError('Failed.');
          }
        } else if (result.status === 'max_iterations') {
          opts.renderer.writeWarning(`Hit max iterations (${result.iterations}).`);
        }

        // ── SDD Auto-Detection ──────────────────────────────────────────
        // When an SDD session is active, auto-detect spec and task JSON
        // in the AI output and save them to the session.
        if (result.status === 'done' && result.finalText && sddContext) {
          // Try to detect and save a spec
          const specSaved = await trySaveSpecFromAIOutput(result.finalText);
          if (specSaved) {
            opts.renderer.write(
              `\n${color.cyan('  ✓ Spec detected and saved! Use /sdd approve to continue.')}\n`,
            );
          }

          // Try to save implementation plan (text before task JSON)
          const planSaved = trySaveImplementationPlan(result.finalText);
          if (planSaved) {
            opts.renderer.write(`\n${color.cyan('  ✓ Implementation plan saved!')}\n`);
          }

          // Try to detect and save tasks
          const tasksSaved = await trySaveTasksFromAIOutput(result.finalText);
          if (tasksSaved) {
            const progress = getTaskProgress();
            const count = progress?.total ?? 0;
            opts.renderer.write(
              `\n${color.cyan(`  ✓ ${count} tasks detected and saved! Use /sdd approve to execute.`)}\n`,
            );
          }

          // Auto-detect task completion during execution phase
          const phase = getActiveSDDPhase();
          if (phase === 'executing') {
            const autoCompleted = autoDetectTaskCompletion(result.finalText);
            if (autoCompleted > 0) {
              const progress = getTaskProgress();
              if (progress) {
                opts.renderer.write(
                  `\n${color.cyan(`  ✓ ${autoCompleted} task(s) auto-completed! Progress: ${progress.completed}/${progress.total} (${progress.percentComplete}%)`)}\n`,
                );
                if (progress.percentComplete === 100) {
                  opts.renderer.write(
                    `\n${color.green('  🎉 All tasks completed! Use /sdd cancel to end the session.')}\n`,
                  );
                }
              }
              // Auto-advance: set the next ready task to in_progress
              advanceToNextTask();
              // Show updated task list after auto-advance
              const taskList = renderTaskListWithProgress();
              if (taskList) {
                opts.renderer.write(`\n${color.dim(taskList)}\n`);
              }
            } else {
              // Still show task list even if nothing was auto-completed
              const taskList = renderTaskListWithProgress();
              if (taskList) {
                opts.renderer.write(`\n${color.dim(taskList)}\n`);
              }
            }
          }
        }

        // ── Suggestion auto-parsing ─────────────────────────────────────
        // Extract "💡 Next steps" from the agent's final output and store
        // them so the user can select with /next 1, /next 1 2 3.
        if (result.status === 'done' && result.finalText && opts.onSuggestionsParsed) {
          const parsed = parseSuggestionsFromOutput(result.finalText);
          opts.onSuggestionsParsed(parsed);
        }

        if (opts.tokenCounter && before) {
          const after = opts.tokenCounter.total();
          const costAfter = opts.tokenCounter.estimateCost().total;
          const effectiveMaxContext =
            opts.getEffectiveMaxContext?.() ?? opts.effectiveMaxContext;
          const ctxChip =
            effectiveMaxContext && effectiveMaxContext > 0
              ? `  ctx: ${renderContextChip(after.input, effectiveMaxContext)}`
              : '';
          opts.renderer.write(
            `\n${color.dim(
              `[in: ${fmtTok(after.input - before.input)}  out: ${fmtTok(after.output - before.output)}  iters: ${result.iterations}  cost: ${(costAfter - costBefore).toFixed(4)}  ${((Date.now() - startedAt) / 1000).toFixed(1)}s]${ctxChip}`,
            )}\n`,
          );
        }

        // Autonomy loop: after a successful run, if autonomy is active,
        // ask the agent to suggest next steps and optionally auto-continue.
        if (result.status === 'done' && opts.getAutonomy) {
          const autonomy = opts.getAutonomy();
          if (autonomy === 'auto') {
            // Self-driving: ask the agent to continue with the next logical step.
            const nextPrompt =
              'Based on what you just did, what is the single most important next step? ' +
              'Just do it — execute the next logical step without asking for confirmation. ' +
              'If there is nothing meaningful left to do, say "DONE" and nothing else.';
            opts.renderer.write(color.dim('\n  ↳ [autonomy] continuing…\n'));
            const nextBlocks = [{ type: 'text' as const, text: nextPrompt }];
            const nextCtrl = new AbortController();
            activeCtrl = nextCtrl;
            try {
              const nextResult = await opts.agent.run(nextBlocks, { signal: nextCtrl.signal });
              opts.onAgentIterationComplete?.(
                estimateRequestTokensCalibrated(
                  opts.agent.ctx.messages,
                  opts.agent.ctx.systemPrompt,
                  opts.agent.ctx.tools ?? [],
                ).total,
              );
              if (nextResult.status === 'done' && nextResult.finalText?.trim() === 'DONE') {
                opts.renderer.write(color.dim('\n  ↳ [autonomy] agent reports task complete.\n'));
              }
              // Loop continues — the for(;;) will read next input, but since
              // we're in auto mode, we need to re-trigger. We use a flag.
              if (opts.getAutonomy() === 'auto' && nextResult.status === 'done') {
                // Re-trigger: the outer loop will continue and we'll hit this
                // block again on the next iteration. But we need user input...
                // Instead, we just continue the loop with the next prompt.
              }
            } catch (err) {
              opts.renderer.writeError(
                `[autonomy] ${toErrorMessage(err)}`,
              );
            } finally {
              activeCtrl = undefined;
            }
          } else if (autonomy === 'suggest') {
            // Suggest mode: ask the agent what to do next, show to user.
            const suggestPrompt =
              'Based on what you just did, suggest 3 concrete next steps. ' +
              'Format: numbered list, one line each, no explanation. ' +
              'If there is nothing meaningful left, say "No further steps needed."';
            const suggestBlocks = [{ type: 'text' as const, text: suggestPrompt }];
            const suggestCtrl = new AbortController();
            activeCtrl = suggestCtrl;
            try {
              const suggestResult = await opts.agent.run(suggestBlocks, {
                signal: suggestCtrl.signal,
              });
              opts.onAgentIterationComplete?.(
                estimateRequestTokensCalibrated(
                  opts.agent.ctx.messages,
                  opts.agent.ctx.systemPrompt,
                  opts.agent.ctx.tools ?? [],
                ).total,
              );
              if (suggestResult.status === 'done' && suggestResult.finalText) {
                opts.renderer.write(
                  `\n${color.cyan('  Suggested next steps:')}\n${suggestResult.finalText}\n`,
                );
                // Parse and store the autonomy-generated suggestions too
                if (opts.onSuggestionsParsed) {
                  const parsed = parseSuggestionsFromOutput(suggestResult.finalText);
                  opts.onSuggestionsParsed(parsed);
                }
              }
            } catch {
              // Silently skip suggestion errors
            } finally {
              activeCtrl = undefined;
            }
          }
        }

        // ── Next-task prediction (/next) ────────────────────────────────
        // Opt-in: after a completed turn, a cheap single-shot LLM call
        // guesses the user's likely next steps and shows them dimly.
        // Display-only — never executed. Only runs when autonomy is off
        // (auto/suggest/eternal already drive or print their own next
        // steps). Best-effort: any failure is swallowed so prediction can
        // never break the turn.
        if (result.status === 'done' && opts.getNextPredict?.()) {
          const autonomy = opts.getAutonomy?.() ?? 'off';
          if (autonomy === 'off') {
            const predictCtrl = new AbortController();
            activeCtrl = predictCtrl;
            try {
              const predictions = await predictNextTasks(
                {
                  userRequest: trimmed,
                  assistantSummary: result.finalText ?? '',
                  todos: opts.agent.ctx.todos,
                },
                {
                  provider: opts.agent.ctx.provider as never as PredictLLMProvider,
                  model: opts.agent.ctx.model,
                  signal: predictCtrl.signal,
                },
              );
              if (predictions.length > 0) {
                const lines = predictions.map((p, i) => `    ${i + 1}. ${p}`).join('\n');
                opts.renderer.write(`\n${color.dim('  ↳ likely next:')}\n${color.dim(lines)}\n`);
              }
            } catch {
              // Best-effort — never let prediction break the turn.
            } finally {
              activeCtrl = undefined;
            }
          }
        }
      } catch (err) {
        opts.renderer.writeError(toErrorMessage(err));
      } finally {
        activeCtrl = undefined;
      }
    }

    return 0;
  } finally {
    // Ensure listener + reader cleanup happens on every exit path: normal
    // EOF, /quit, an uncaught throw, etc. Without this, a thrown exception
    // mid-loop would leave the SIGINT handler attached for the rest of
    // the process lifetime (and the reader's terminal handle open).
    process.off('SIGINT', onSigint);
    await opts.reader.close().catch(() => {
      /* best-effort */
    });
    // Stop the client heartbeat so this REPL is marked offline.
    clearInterval(clientHeartbeat);
    hqConnection.stop();
    // Run user-provided cleanup (e.g., SessionStats event listener removal).
    opts.onDestroy?.();
  }
}

async function pasteClipboardImage(builder: InputBuilder, opts: ReplOptions): Promise<void> {
  try {
    const img = await readClipboardImage();
    if (!img) {
      opts.renderer.write(color.dim('  no image on clipboard\n'));
      return;
    }
    const placeholder = await builder.appendImage(img.base64, img.mediaType);
    const kb = (img.bytes / 1024).toFixed(0);
    opts.renderer.write(color.dim(`  ↳ ${placeholder} (PNG ${kb}KB)\n`));
  } catch (err) {
    opts.renderer.writeError(
      `Clipboard image error: ${toErrorMessage(err)}`,
    );
  }
}

/**
 * Read the persisted goal file safely. Returns null on any error so the
 * REPL never crashes because /goal infrastructure is missing.
 */
async function loadGoalSafe(opts: ReplOptions): Promise<GoalFile | null> {
  if (!opts.projectRoot) return null;
  try {
    return await loadGoal(goalFilePath(opts.projectRoot));
  } catch {
    return null;
  }
}

/**
 * Print a one-line status banner about the active goal — only when a
 * goal file exists. If the previous session left the engine in 'running'
 * state, prompt the user (y/N) to resume eternal mode directly so they
 * don't have to retype the slash command. Default is N (safe path) — a
 * stray Enter after an unexpected crash shouldn't auto-burn tokens.
 */
async function renderGoalBanner(opts: ReplOptions): Promise<void> {
  const goal = await loadGoalSafe(opts);
  if (!goal) return;

  const summary = goal.goal.length > 80 ? `${goal.goal.slice(0, 77)}…` : goal.goal;

  // Color based on goalState
  const stateColor =
    goal.goalState === 'active'
      ? color.green
      : goal.goalState === 'paused'
        ? color.amber
        : goal.goalState === 'completed'
          ? color.green
          : goal.goalState === 'abandoned'
            ? color.dim
            : color.dim;

  opts.renderer.write(
    color.dim('Goal: ') +
      stateColor(summary) +
      color.dim(` [${goal.goalState}]  (iter ${goal.iterations})`) +
      '\n',
  );

  // Show journal summary if there are recent entries
  if (goal.journal.length > 0) {
    const lastEntry = expectDefined(goal.journal[goal.journal.length - 1]);
    const statusIcon =
      lastEntry.status === 'success'
        ? '✓'
        : lastEntry.status === 'failure'
          ? '✗'
          : lastEntry.status === 'aborted'
            ? '⊘'
            : lastEntry.status === 'skipped'
              ? '⊝'
              : '·';
    opts.renderer.write(
      color.dim(`  Last: ${statusIcon} ${lastEntry.task} (${lastEntry.status})`) + '\n',
    );
  }

  if (goal.engineState === 'running') {
    opts.renderer.write(
      color.amber('  ↺ Eternal engine was running when last session ended.') + '\n',
    );
    // Try an interactive y/N prompt. If reader is unavailable or throws
    // (non-TTY, redirected stdin, etc.) fall back to the static hint.
    try {
      const answer = (await opts.reader.readLine(color.dim('  Resume eternal mode? [y/N] ')))
        .trim()
        .toLowerCase();
      if (answer === 'y' || answer === 'yes') {
        // Dispatch /autonomy eternal as if the user typed it. Routes
        // through the normal slash path so YOLO force-on, prime(), banner
        // semantics all kick in consistently.
        try {
          await opts.slashRegistry.dispatch('/autonomy eternal', opts.agent.ctx);
        } catch (err) {
          opts.renderer.writeError(
            `Auto-resume failed: ${toErrorMessage(err)}`,
          );
        }
      } else {
        opts.renderer.write(
          color.dim('  Not resuming. Use `/autonomy eternal` later to continue.') + '\n',
        );
      }
    } catch {
      // Non-interactive path: just hint.
      opts.renderer.write(color.dim('  Use `/autonomy eternal` to resume.') + '\n');
    }
  } else if (goal.goalState === 'paused') {
    // Paused goal - prompt to resume
    opts.renderer.write(color.amber('  ⏸ Goal is paused. Use `/goal resume` to continue.') + '\n');
  } else if (goal.goalState === 'completed') {
    opts.renderer.write(
      color.green('  ✓ Goal completed! Use `/goal clear` to set a new goal.') + '\n',
    );
  } else if (goal.goalState === 'abandoned') {
    opts.renderer.write(color.dim('  Use `/goal clear` to set a new goal.') + '\n');
  }
  opts.renderer.write('\n');
}

/**
 * Run the full auto-proceed cycle: countdown, feed suggestion to agent,
 * parse new suggestions from the response.  Returns normally when the
 * agent turn completes, throws on abort (Ctrl+C).
 *
 * The caller must set `activeCtrl` before calling and clear it after.
 */
async function runAutoProceed(
  opts: ReplOptions,
  suggestion: string,
  delayMs: number,
  ctrl: AbortController,
): Promise<void> {
  const truncated = suggestion.length > 80 ? `${suggestion.slice(0, 77)}…` : suggestion;
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'auto_proceed_started',
      suggestion: truncated,
      delayMs,
    }),
  );
  try {
    // ── Productive cooldown: compact context while we wait ─────────
    const proceed = await autoProceedCooldown(opts, delayMs, suggestion, ctrl.signal);
    if (!proceed) {
      // Countdown was cancelled (host callback or abort signal) — do NOT
      // feed the suggestion. Resolving here without running keeps the
      // "cancel" semantics honest instead of fast-forwarding the run.
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'auto_proceed_cancelled',
          suggestion: truncated,
        }),
      );
      return;
    }
    // ── Feed the suggestion as if it were runText ──────────────────
    const runBlocks = [{ type: 'text' as const, text: suggestion }];
    const runResult = await opts.agent.run(runBlocks, { signal: ctrl.signal });
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'auto_proceed_completed',
        suggestion: truncated,
        status: runResult.status,
        iterations: runResult.iterations,
      }),
    );
    opts.onAgentIterationComplete?.(
      estimateRequestTokensCalibrated(
        opts.agent.ctx.messages,
        opts.agent.ctx.systemPrompt,
        opts.agent.ctx.tools ?? [],
      ).total,
    );
    // Parse suggestions from the auto-triggered turn
    if (runResult.status === 'done' && runResult.finalText && opts.onSuggestionsParsed) {
      const parsed = parseSuggestionsFromOutput(runResult.finalText);
      opts.onSuggestionsParsed(parsed);
    }
  } finally {
    // activeCtrl cleanup is handled by the caller
  }
}
/**
 * Productive cooldown between auto-proceed iterations.
 * Instead of a dead countdown, runs context compaction in the background
 * and only waits the full delay if compaction finishes early
 * (so the user gets a responsive Ctrl+C while still compacting).
 *
 * When delayMs is 0, skips straight to feeding the suggestion.
 *
 * Resolves `true` when the countdown ran to completion (proceed with the
 * suggestion) and `false` when it was cancelled — either by the abort
 * signal or by `onCountdownTick` returning true. A final `onCountdownTick(0)`
 * fires on every exit path so display consumers can clear their chip.
 */
async function autoProceedCooldown(
  opts: ReplOptions,
  delayMs: number,
  suggestion: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (delayMs <= 0) return true; // immediate — no wait at all

  const truncated = suggestion.length > 100 ? `${suggestion.slice(0, 97)}…` : suggestion;
  const sec = Math.ceil(delayMs / 1000);

  opts.renderer.write(`\n${color.cyan('⏳ Auto')}  ${color.dim('(Ctrl+C to cancel)')}\n`);
  opts.renderer.write(`${color.dim('  ▸')} ${color.dim(truncated)}\n`);

  // ── Run compaction during the cooldown ────────────────────────
  void runContextCompaction(opts, signal);

  const start = Date.now();
  let interval: ReturnType<typeof setInterval> | undefined;
  let lastTickedSecond = sec + 1; // Start one ahead so first tick fires immediately
  let onAbort: (() => void) | undefined;

  return new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });

    interval = setInterval(() => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, Math.ceil((delayMs - elapsed) / 1000));
      if (remaining <= 0) {
        opts.renderer.write(color.dim(`  ↳ ${truncated}\n`));
        resolve(true);
        return;
      }
      // Surface the tick to the host once per second; a `true` return
      // cancels the countdown (and the pending suggestion with it).
      if (opts.onCountdownTick && remaining !== lastTickedSecond) {
        lastTickedSecond = remaining;
        try {
          const shouldAbort = opts.onCountdownTick(remaining);
          if (shouldAbort === true) {
            opts.renderer.write(
              color.yellow('  ↳ Countdown cancelled — switching to manual mode\n'),
            );
            resolve(false);
            return;
          }
        } catch {
          // Host callback errors must not break the countdown
        }
      }
      if (remaining % 5 === 0 || remaining === sec) {
        opts.renderer.write(color.dim(`  ⏳ ${remaining}s…\n`));
      }
    }, 1000);
  }).finally(() => {
    if (interval) clearInterval(interval);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    // Final 0-tick on every exit path — lets display consumers (TUI
    // status-bar chip) clear instead of freezing at the last value.
    try {
      opts.onCountdownTick?.(0);
    } catch {
      /* display-only */
    }
  });
}

/**
 * Run context compaction best-effort. Catches all errors silently so it
 * never interrupts the auto-proceed flow. Returns immediately if the
 * agent's context has no compactor wired up.
 */
async function runContextCompaction(opts: ReplOptions, _signal: AbortSignal): Promise<void> {
  try {
    const ctx = opts.agent.ctx as never as {
      messages?: Array<unknown>;
      compactor?: { compact(ctx: unknown, opts: { aggressive: boolean }): Promise<void> };
    };
    if (!ctx?.compactor) return;
    // Quick check: only compact if we've added meaningful message volume
    // since the last compaction (heuristic: >50 messages).
    if ((ctx.messages?.length ?? 0) < 50) return;
    await ctx.compactor.compact(ctx, { aggressive: false });
  } catch {
    // Best-effort — never let compaction break the auto loop
  }
}

/**
 * Read a line, but support two multiline patterns:
 *   1. Trailing `\` → continue on the next line (shell-style line continuation).
 *   2. A line that is exactly `"""` → start a heredoc; keep reading until
 *      another bare `"""`. Useful for pasting code snippets.
 * Returns the assembled text and whether it came from a heredoc block (so
 * the caller can decide to always collapse heredocs as pastes).
 */
async function readPossiblyMultiline(opts: ReplOptions): Promise<string> {
  const firstPrompt = theme.primary('› ');
  const contPrompt = color.dim('· ');
  const first = await opts.reader.readLine(firstPrompt);

  if (first.trim() === '"""') {
    const parts: string[] = [];
    try {
      for (;;) {
        const next = await opts.reader.readLine(contPrompt);
        if (next.trim() === '"""') break;
        parts.push(next);
      }
    } catch {
      // EOF (Ctrl+D) during heredoc — user typed """ then quit.
      // Return what we have; the outer catch breaks the main loop.
      return parts.join('\n');
    }
    return parts.join('\n');
  }

  let buf = first;
  while (buf.endsWith('\\')) {
    buf = buf.slice(0, -1); // drop the trailing backslash
    const cont = await opts.reader.readLine(contPrompt);
    buf += '\n' + cont;
  }
  return buf;
}

const FILLED = '█';
const EMPTY = '░';

function renderContextChip(used: number, max: number): string {
  const ratio = Math.max(0, Math.min(1, used / max));
  const pct = Math.round(ratio * 100);
  const bar = renderProgress(ratio, 6);
  return `${bar} ${pct}% (${fmtTok(used)}/${fmtTok(max)})`;
}

function renderProgress(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round(clamped * width));
  const capped = Math.min(width, filled);
  return FILLED.repeat(capped) + EMPTY.repeat(width - capped);
}

function printBanner(renderer: TerminalRenderer, projectName?: string): void {
  const lines = [
    theme.primary(theme.bold('WrongStack')) + color.dim(` v${CLI_VERSION}`),
    color.dim('Built on the wrong stack. Shipped anyway.'),
  ];
  if (projectName && projectName.length > 0) {
    lines.push(color.dim('Project: ') + theme.bold(projectName));
  }
  lines.push(color.dim('Type /help for commands, /exit or q to quit.'), '');
  renderer.write(`${lines.join('\n')}\n`);
}
