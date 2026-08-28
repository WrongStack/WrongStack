import { detectContinueIntent, InputBuilder, resolveContinuation } from '@wrongstack/core/agent';
import {
  color,
  estimateRequestTokensCalibrated,
  hasOpenTodos,
  toErrorMessage,
} from '@wrongstack/core/utils';
import { readClipboardImage, routeImagesForModel } from '@wrongstack/runtime';
import { createAutoProceedLoopGuard } from '@wrongstack/tools/auto-proceed-loop-guard';
import { todoTool } from '@wrongstack/tools/todo';
import { contextOverflowHint } from './context-overflow-diagnostic.js';
import { type PredictLLMProvider, predictNextTasks } from './next-task-predictor.js';
import { runAutoProceed } from './repl-auto-proceed.js';
import { registerReplClient } from './repl-client-registration.js';
import { runReplEternalLoop } from './repl-eternal-loop.js';
import { renderGoalBanner } from './repl-goal-banner.js';
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
export { parseSuggestionsFromOutput } from './repl-suggestions.js';;

export async function runRepl(opts: ReplOptions): Promise<number> {
  if (opts.banner !== false) printBanner(opts.renderer, opts.projectName);
  await renderGoalBanner(opts);

  let activeCtrl: AbortController | undefined;
  let interrupts = 0;
  if (opts.interruptController) {
    opts.interruptController.abortLeader = () => {
      if (activeCtrl) {
        activeCtrl.abort();
        return true;
      }
      return false;
    };
  }
  let autoIterCount = 0;
  let autoCapWarned = false;
  const autoProceedLoopGuard = createAutoProceedLoopGuard();
  let exiting = false;
  const onSigint = () => {
    interrupts++;
    if (interrupts >= 3) {
      process.exit(130);
    }
    if (interrupts >= 2) {
      opts.renderer.writeWarning('Exiting.');
      exiting = true;
      activeCtrl?.abort();
      const hardExit = setTimeout(() => process.exit(130), 2_000);
      hardExit.unref?.();
      return;
    }
    if (opts.getAutonomy?.() === 'eternal' || opts.getAutonomy?.() === 'eternal-parallel') {
      opts.getEternalEngine?.()?.stop();
      opts.getParallelEngine?.()?.stop();
      opts.onAutonomy?.('off');
      opts.renderer.writeWarning('Engine stop requested. Press Ctrl+C again to exit.');
      interrupts = 0;
      return;
    }
    const sddRun = opts.getSddRun?.();
    if (sddRun?.isRunning()) {
      sddRun.stop();
      opts.renderer.writeWarning('SDD run stop requested. Press Ctrl+C again to exit.');
      interrupts = 0;
      return;
    }
    if (activeCtrl) {
      activeCtrl.abort();
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

  try {
    for (;;) {
      if (exiting) break;

      const autonomy = opts.getAutonomy?.();
      if (autonomy === 'eternal' || autonomy === 'eternal-parallel') {
        const handled = await runReplEternalLoop(opts, () => {
          interrupts = 0;
        });
        if (handled) continue;
      }

      // ── Auto-proceed / suggest: autonomy-driven next-step flow ──
      {
        const mode = opts.getAutonomy?.() ?? 'off';
        const suggestions = opts.getSuggestions?.() ?? [];

        if (mode === 'suggest' && suggestions.length > 0) {
          const lines = suggestions.map((s, i) => `  ${color.bold(`${i + 1}.`)} ${color.dim(s)}`);
          opts.renderer.write(
            `\n${color.cyan('  💡 Suggested next steps')}  ${color.dim('(use /next 1, /next 2, or /next 1 2 3)')}\n${lines.join('\n')}\n\n`,
          );
        }

        if (mode === 'auto') {
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
                await todoTool.execute(
                  {
                    todos: todos.map((todo) =>
                      todo.id === resolved.todoId
                        ? { ...todo, status: 'in_progress' as const }
                        : todo.status === 'in_progress'
                          ? { ...todo, status: 'pending' as const }
                          : todo,
                    ),
                  },
                  opts.agent.ctx,
                  { signal: AbortSignal.timeout(30_000) },
                );
              }
            }
          }

          if (top) {
            const maxAuto = opts.autoProceedMaxIterations ?? DEFAULT_MAX_CONSECUTIVE_AUTO_PROCEED;
            if (maxAuto > 0 && autoIterCount >= maxAuto) {
              if (!autoCapWarned) {
                autoCapWarned = true;
                opts.renderer.writeWarning(
                  `Auto-proceed paused after ${maxAuto} consecutive automatic turns — ` +
                    'enter input to continue (resets the counter). Autonomy stays on.',
                );
              }
            } else {
              const delay = opts.autoProceedDelayMs ?? 1_000;
              const ctrl = new AbortController();
              activeCtrl = ctrl;
              try {
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
            }
          }
        }
      }

      let raw: string;
      try {
        raw = await readPossiblyMultiline(opts);
      } catch {
        break;
      }
      const trimmed = raw.trim();
      if (!trimmed) {
        interrupts = 0;
        continue;
      }
      interrupts = 0;
      autoIterCount = 0;
      autoCapWarned = false;
      autoProceedLoopGuard.reset();

      if (trimmed === 'q') {
        opts.renderer.write(color.dim('  Goodbye!\n'));
        break;
      }

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
                const sddPhase = getActiveSDDPhase();
                if (sddPhase === 'executing') {
                  const autoCompleted = autoDetectTaskCompletion(runResult.finalText);
                  if (autoCompleted > 0) {
                    const progress = getTaskProgress();
                    if (progress) {
                      opts.renderer.write(
                        `\n${color.cyan(`  ✓ ${autoCompleted} task(s) auto-completed! Progress: ${progress.completed}/${progress.total} (${progress.percentComplete}%)`)}\n`,
                      );
                      const taskList = renderTaskListWithProgress();
                      if (taskList) {
                        opts.renderer.write(`\n${color.dim(taskList)}\n`);
                      }
                    }
                  } else {
                    const taskList = renderTaskListWithProgress();
                    if (taskList) {
                      opts.renderer.write(`\n${color.dim(taskList)}\n`);
                    }
                  }
                }

                if (opts.onSuggestionsParsed) {
                  const parsed = parseSuggestionsFromOutput(
                    runResult.finalText,
                    opts.agent.ctx.todos,
                  );
                  opts.onSuggestionsParsed(parsed);
                }
              }
            } catch (_runErr) {
              opts.renderer.writeWarning('AI auto-trigger failed. You can continue manually.');
            }
          }
        } catch (err) {
          opts.renderer.writeError(toErrorMessage(err));
        }
        continue;
      }

      if (detectContinueIntent(trimmed)) {
        const resolved = resolveContinuation({
          todos: opts.agent.ctx.todos,
          suggestions: getSuggestions(),
        });
        if (resolved.source === 'todo' && resolved.todoId) {
          const selected = opts.agent.ctx.todos.find((todo) => todo.id === resolved.todoId);
          if (selected?.status === 'pending') {
            await todoTool.execute(
              {
                todos: opts.agent.ctx.todos.map((todo) =>
                  todo.id === resolved.todoId
                    ? { ...todo, status: 'in_progress' as const }
                    : todo.status === 'in_progress'
                      ? { ...todo, status: 'pending' as const }
                      : todo,
                ),
              },
              opts.agent.ctx,
              { signal: AbortSignal.timeout(30_000) },
            );
          }
        }
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
        const ph = await builder.appendPaste(raw);
        if (ph) {
          const lineCount = raw.split('\n').length;
          opts.renderer.write(color.dim(`  ↳ ${ph} (${lineCount} lines)\n`));
        }
      }
      const blocks = await builder.submit();

      const sddContext = getActiveSDDContext();
      const taskList = getTaskListText();
      const taskProgress = getTaskProgress();
      const sddPhase = getActiveSDDPhase();

      let sddPrefix = '';
      if (sddContext) {
        sddPrefix = `[SDD SESSION ACTIVE]\n${sddContext}`;
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

        if (result.status === 'done' && result.finalText && sddContext) {
          const specSaved = await trySaveSpecFromAIOutput(result.finalText);
          if (specSaved) {
            opts.renderer.write(
              `\n${color.cyan('  ✓ Spec detected and saved! Use /sdd approve to continue.')}\n`,
            );
          }

          const planSaved = trySaveImplementationPlan(result.finalText);
          if (planSaved) {
            opts.renderer.write(`\n${color.cyan('  ✓ Implementation plan saved!')}\n`);
          }

          const tasksSaved = await trySaveTasksFromAIOutput(result.finalText);
          if (tasksSaved) {
            const progress = getTaskProgress();
            const count = progress?.total ?? 0;
            opts.renderer.write(
              `\n${color.cyan(`  ✓ ${count} tasks detected and saved! Use /sdd approve to execute.`)}\n`,
            );
          }

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
              advanceToNextTask();
              const taskList = renderTaskListWithProgress();
              if (taskList) {
                opts.renderer.write(`\n${color.dim(taskList)}\n`);
              }
            } else {
              const taskList = renderTaskListWithProgress();
              if (taskList) {
                opts.renderer.write(`\n${color.dim(taskList)}\n`);
              }
            }
          }
        }

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

        if (result.status === 'done' && opts.getAutonomy) {
          const autonomy = opts.getAutonomy();
          if (autonomy === 'suggest' && !hasOpenTodos(opts.agent.ctx.todos)) {
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
              // Best-effort
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
    process.off('SIGINT', onSigint);
    await opts.reader.close().catch(() => {});
    replClientRegistration.close();
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
