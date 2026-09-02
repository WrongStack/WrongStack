/**
 * REPL eternal and parallel autonomy iteration loop handlers.
 *
 * @module repl-eternal-loop
 */

import { goalFilePath, summarizeUsage } from '@wrongstack/core/goal';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import { loadGoalSafe } from './repl-goal-banner.js';
import type { ReplOptions } from './repl-options.js';

export async function runReplEternalLoop(
  opts: ReplOptions,
  onInterruptsReset: () => void,
): Promise<boolean> {
  const autonomy = opts.getAutonomy?.();
  if (autonomy === 'eternal') {
    const engine = opts.getEternalEngine?.();
    if (!engine) {
      opts.renderer.writeWarning('Eternal mode set but no engine wired — falling back to off.');
      return false;
    }

    const beforeGoal = await loadGoalSafe(opts);
    const beforeIter = beforeGoal?.iterations ?? 0;
    opts.renderer.write(color.dim(`\n  ↳ [eternal #${beforeIter + 1}] running iteration…\n`));
    onInterruptsReset();

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
        return true;
      }
    } catch (err) {
      opts.renderer.writeError(`[eternal] ${toErrorMessage(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    return true;
  }

  if (autonomy === 'eternal-parallel') {
    const engine = opts.getParallelEngine?.();
    if (!engine) {
      opts.renderer.writeWarning('Parallel mode set but no engine wired — falling back to off.');
      return false;
    }

    const beforeGoal = await loadGoalSafe(opts);
    const beforeIter = beforeGoal?.iterations ?? 0;

    const coord = engine.getCoordinator();
    if (coord) {
      const stats = coord.getStats();
      opts.renderer.write(
        color.dim(
          `  ┌─ Fleet: ${stats.running} running, ${stats.idle} idle, ${stats.pending} pending, ${stats.completed} done`,
        ) + '\n',
      );
    }

    opts.renderer.write(color.magenta(`  ↳ [parallel #${beforeIter + 1}] launching fan-out…\n`));
    onInterruptsReset();

    try {
      await engine.runOneIteration();
      const afterGoal = await loadGoalSafe(opts);
      const last = afterGoal?.journal[afterGoal.journal.length - 1];

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
        return true;
      }
    } catch (err) {
      opts.renderer.writeError(`[parallel] ${toErrorMessage(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    return true;
  }

  return false;
}
