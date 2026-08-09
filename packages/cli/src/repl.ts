import { detectContinueIntent, InputBuilder, resolveContinuation } from '@wrongstack/core/agent';
import type { GoalFile } from '@wrongstack/core/goal';
import { goalFilePath, loadGoal, summarizeUsage } from '@wrongstack/core/goal';
import {
  color,
  estimateRequestTokensCalibrated,
  expectDefined,
  hasOpenTodos,
  toErrorMessage,
} from '@wrongstack/core/utils';
import { readClipboardImage, routeImagesForModel } from '@wrongstack/runtime';
import { createAutoProceedLoopGuard } from '@wrongstack/tools/auto-proceed-loop-guard';
import { contextOverflowHint } from './context-overflow-diagnostic.js';
import { type PredictLLMProvider, predictNextTasks } from './next-task-predictor.js';
import { runAutoProceed } from './repl-auto-proceed.js';
import { registerReplClient } from './repl-client-registration.js';
import { readPossiblyMultiline } from './repl-input.js';
import type { ReplOptions } from './repl-options.js';
import { printBanner, renderContextChip } from './repl-rendering.js';
import { parseSuggestionsFromOutput } from './repl-suggestions.js';
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
} from './services/sdd-runtime.js';
import { getSuggestions } from './services/suggestion-store.js';
import { fmtTok } from './utils.js';

/** Default ceiling on consecutive auto-proceed turns; 0 in settings means unlimited. */
const DEFAULT_MAX_CONSECUTIVE_AUTO_PROCEED = 50;

export type { ReplOptions } from './repl-options.js';
export { parseAutoSuggestionsFromOutput, parseSuggestionsFromOutput } from './repl-suggestions.js';

export async function runRepl(opts: ReplOptions): Promise<number> {
  if (opts.banner !== false) printBanner(opts.renderer, opts.projectName);
  // Surface active goal + crash-recovery hint under the banner.
  await renderGoalBanner(opts);

  // Per-iteration abort controller; refreshed before every agent.run.
  let activeCtrl: AbortController | undefined;
  let interrupts = 0;
  // Install the leader-abort handler for `/interrupt`; Ctrl+C is the mid-run path.
  if (opts.interruptController) {
    opts.interruptController.abortLeader = () => {
      if (activeCtrl) {
        activeCtrl.abort();
        return true;
      }
      return false;
    };
  }
  // Consecutive auto-proceed turns since the last manual input.
  let autoIterCount = 0;
  let autoCapWarned = false;
  // Repetition guard: when the same prompt is fed 2 times in a row, the
  // model is in a self-feeding loop. Manual input resets this too; the
  // 50-iteration cap above remains the runaway safety net for genuinely
  // novel prompts.
  const autoProceedLoopGuard = createAutoProceedLoopGuard();
  let exiting = false;
  const onSigint = () => {
    interrupts++;
    // Third (or later) press — the graceful exit itself is stuck; leave NOW.
    if (interrupts >= 3) {
      process.exit(130);
    }
    if (interrupts >= 2) {
      opts.renderer.writeWarning('Exiting.');
      exiting = true;
      // Abort whatever is still in flight so the read/run loop can observe
      // `exiting` and unwind gracefully…
      activeCtrl?.abort();
      // …and if it CAN'T (a run wedged past every abort layer), force the
      // process down after a short grace instead of letting "Exiting." be
      // a lie. unref'd so a clean exit is never delayed by this timer.
      const hardExit = setTimeout(() => process.exit(130), 2_000);
      hardExit.unref?.();
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

  const replClientRegistration = registerReplClient(opts);

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
              opts.onAutonomy?.('auto');
              continue;
            }
          } catch (err) {
            opts.renderer.writeError(`[eternal] ${toErrorMessage(err)}`);
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
              opts.onAutonomy?.('auto');
              continue;
            }
          } catch (err) {
            opts.renderer.writeError(`[parallel] ${toErrorMessage(err)}`);
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
        if (mode === 'auto') {
          // Resolve the next auto-feed target: first from suggestions, then
          // from open todos (suggestions are suppressed while todos are
          // pending — see parseSuggestionsFromOutput — so skipping to todos
          // prevents the session from idling after a turn with no nextsteps).
          let top: string;
          let groundedTodo = false;
          if (suggestions.length > 0) {
            const isYolo = opts.getYolo?.() ?? false;
            const autoSuggestions = opts.getAutoSuggestions?.() ?? [];
            const useAutoSuggestions = isYolo && autoSuggestions.length > 0;
            top = useAutoSuggestions ? (autoSuggestions[0] ?? '') : (suggestions[0] ?? '');
          } else {
            const todos = opts.agent.ctx.todos ?? [];
            const resolved = resolveContinuation({ todos, suggestions: [] });
            top = resolved.source === 'todo' ? resolved.text : '';
            groundedTodo = top !== '';
            if (resolved.source === 'todo' && resolved.todoId) {
              const selected = todos.find((todo) => todo.id === resolved.todoId);
              if (selected?.status === 'pending') {
                opts.agent.ctx.state.replaceTodos(
                  todos.map((todo) =>
                    todo.id === resolved.todoId
                      ? { ...todo, status: 'in_progress' as const }
                      : todo.status === 'in_progress'
                        ? { ...todo, status: 'pending' as const }
                        : todo,
                  ),
                );
              }
            }
          }

          if (!top) {
            // Fall through to the input read below — nothing to auto-feed.
          } else {
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
              const delay = opts.autoProceedDelayMs ?? 1_000;
              const ctrl = new AbortController();
              activeCtrl = ctrl;
              try {
                // For YOLO+auto, apply the autonomy_next prompt template.
                const isYolo = opts.getYolo?.() ?? false;
                const autoSuggestions = opts.getAutoSuggestions?.() ?? [];
                const useAutoSuggestions = isYolo && autoSuggestions.length > 0;
                const promptToFeed =
                  useAutoSuggestions && opts.autonomyNextPrompt
                    ? opts.autonomyNextPrompt.replace('{{suggestion}}', top)
                    : top;
                const submitted = await runAutoProceed(
                  opts,
                  promptToFeed,
                  delay,
                  ctrl,
                  autoProceedLoopGuard,
                  groundedTodo,
                );
                if (submitted) {
                  autoIterCount++;
                  continue;
                }
              } finally {
                activeCtrl = undefined;
              }
              // Countdown cancellation, autonomy changes, and repetition
              // halts all return control to manual input.
            }
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
      autoProceedLoopGuard.reset();

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
                // not stale ones from a prior /suggest. The live todo
                // list is passed through so we suppress <nextsteps> while
                // the in-flight todo loop is still in progress.
                if (opts.onSuggestionsParsed) {
                  const parsed = parseSuggestionsFromOutput(
                    runResult.finalText,
                    opts.agent.ctx.todos,
                  );
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

      // ── Bare "continue" → resolve against live plan state ────────────────
      // A lone "continue" / "devam" / "go on" carries no instruction. Resolve
      // it against what we already track — the next open todo, else the top
      // stored suggestion, else an open continuation that keeps the agent
      // working without fabricating busywork — and inject that concrete text
      // in place of the bare word. Skips paste collapsing (the injected text
      // is prose, not a paste).
      if (detectContinueIntent(trimmed)) {
        const resolved = resolveContinuation({
          todos: opts.agent.ctx.todos,
          suggestions: getSuggestions(),
        });
        if (resolved.source === 'todo' && resolved.todoId) {
          const selected = opts.agent.ctx.todos.find((todo) => todo.id === resolved.todoId);
          if (selected?.status === 'pending') {
            opts.agent.ctx.state.replaceTodos(
              opts.agent.ctx.todos.map((todo) =>
                todo.id === resolved.todoId
                  ? { ...todo, status: 'in_progress' as const }
                  : todo.status === 'in_progress'
                    ? { ...todo, status: 'pending' as const }
                    : todo,
              ),
            );
          }
        }
        // Make the resolution — and its drift risk — visible instead of
        // silently guessing. A grounded resolution (todo/suggestion) prints
        // its target and proceeds; the `open` guess warns that "continue" has
        // no anchor and asks before letting the model pick a step itself.
        if (resolved.source === 'open') {
          opts.renderer.write(
            `  ${color.amber('⚠')} ${color.bold("'continue' has no anchor")} ${color.dim('— no pending todo or suggestion.')}\n` +
              color.dim(
                "     If you proceed, I'll choose the next step from context; that can drift.\n",
              ),
          );
          const ans = (
            await opts.reader.readLine(color.dim('  Proceed anyway? [Y/n · e = type your own] '))
          )
            .trim()
            .toLowerCase();
          if (ans === 'n' || ans === 'no') {
            opts.renderer.write(color.dim('  Cancelled — nothing sent.\n'));
            continue;
          }
          if (ans === 'e' || ans === 'edit') {
            opts.renderer.write(color.dim('  Okay — type what to continue with.\n'));
            continue;
          }
        } else {
          opts.renderer.write(color.dim(`  ${resolved.label}\n`));
        }
        builder.appendText(resolved.text);
      } else {
        // Route through InputBuilder so big pastes collapse to placeholders.
        const ph = await builder.appendPaste(raw);
        if (ph) {
          const lineCount = raw.split('\n').length;
          opts.renderer.write(color.dim(`  ↳ ${ph} (${lineCount} lines)\n`));
        }
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
        // them so the user can select with /next 1, /next 1 2 3. The live
        // todo list is passed through so we suppress <nextsteps> while
        // the in-flight todo loop is still in progress — finishing the
        // open todos comes before offering new prompt options.
        if (result.status === 'done' && result.finalText && opts.onSuggestionsParsed) {
          const parsed = parseSuggestionsFromOutput(result.finalText, opts.agent.ctx.todos);
          opts.onSuggestionsParsed(parsed);
        }

        if (opts.tokenCounter && before) {
          const after = opts.tokenCounter.total();
          const costAfter = opts.tokenCounter.estimateCost().total;
          const effectiveMaxContext = opts.getEffectiveMaxContext?.() ?? opts.effectiveMaxContext;
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

        // Suggest mode asks for explicit next-step options after a successful
        // turn. Auto mode is driven exclusively by the guarded queue at the
        // top of the REPL loop; issuing another agent.run() here would bypass
        // suggestion consumption and the repetition guard.
        if (result.status === 'done' && opts.getAutonomy) {
          const autonomy = opts.getAutonomy();
          if (autonomy === 'suggest' && !hasOpenTodos(opts.agent.ctx.todos)) {
            // Suggest mode: ask the agent what to do next, show to user.
            const suggestPrompt =
              'Based on what you just did, suggest 3 exact prompt messages that can be submitted back to you through the TUI or WebUI. Each prompt must ask the agent to perform work; never assign a manual chore to the user. ' +
              'If you include suggestions, wrap them in a balanced <nextsteps>...</nextsteps> block, ' +
              'with one numbered prompt per line and no explanation. ' +
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
                  const parsed = parseSuggestionsFromOutput(
                    suggestResult.finalText,
                    opts.agent.ctx.todos,
                  );
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
        //
        // Skipped while a todo list is in flight: the next step is the
        // next todo, not a /next prediction. A second "likely next"
        // line under the in-flight todo list would be noise.
        if (
          result.status === 'done' &&
          opts.getNextPredict?.() &&
          !hasOpenTodos(opts.agent.ctx.todos)
        ) {
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
    replClientRegistration.close();
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
    opts.renderer.writeError(`Clipboard image error: ${toErrorMessage(err)}`);
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
          opts.renderer.writeError(`Auto-resume failed: ${toErrorMessage(err)}`);
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
