/**
 * REPL goal banner rendering and safe goal file loading.
 *
 * @module repl-goal-banner
 */

import type { GoalFile } from '@wrongstack/core/goal';
import { goalFilePath, loadGoal } from '@wrongstack/core/goal';
import { color, expectDefined, toErrorMessage } from '@wrongstack/core/utils';
import type { ReplOptions } from './repl-options.js';

/**
 * Read the persisted goal file safely. Returns null on any error so the
 * REPL never crashes because /goal infrastructure is missing.
 */
export async function loadGoalSafe(opts: ReplOptions): Promise<GoalFile | null> {
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
export async function renderGoalBanner(opts: ReplOptions): Promise<void> {
  const goal = await loadGoalSafe(opts);
  if (!goal) return;

  const summary = goal.goal.length > 80 ? `${goal.goal.slice(0, 77)}…` : goal.goal;

  const stateColor =
    goal.goalState === 'active'
      ? color.green
      : goal.goalState === 'paused'
        ? color.amber
        : goal.goalState === 'completed'
          ? color.green
          : color.dim;

  opts.renderer.write(
    color.dim('Goal: ') +
      stateColor(summary) +
      color.dim(` [${goal.goalState}]  (iter ${goal.iterations})`) +
      '\n',
  );

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
    try {
      const answer = (await opts.reader.readLine(color.dim('  Resume eternal mode? [y/N] ')))
        .trim()
        .toLowerCase();
      if (answer === 'y' || answer === 'yes') {
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
      opts.renderer.write(color.dim('  Use `/autonomy eternal` to resume.') + '\n');
    }
  } else if (goal.goalState === 'paused') {
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
