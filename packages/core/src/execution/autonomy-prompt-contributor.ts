/**
 * System-prompt contributor that surfaces eternal-autonomy state to the
 * model on every turn.
 *
 * Why this exists: when the engine drives a long-running loop, the
 * per-iteration directive carries the rules. But the directive is a USER
 * message — it scrolls out of working memory after a few compactions and
 * the model forgets it's in autonomy mode (forgets `[GOAL_COMPLETE]`,
 * forgets the todo-state protocol, forgets the no-confirmation rule).
 * Injecting the same anchor as a CACHED system-prompt block solves that
 * — the rules sit next to the identity layer and survive compactions.
 *
 * Block is tagged `ephemeral` so its content (journal tail, iteration
 * counter) changes each turn without invalidating the upstream prefix
 * cache.
 */

import type { TextBlock } from '../types/blocks.js';
import type { BuildContext } from '../types/system-prompt.js';
import type { SystemPromptContributor } from '../types/system-prompt-contributor.js';
import { loadGoal } from '../storage/goal-store.js';
import {
  readBundledInstructionText,
  renderInstructionTemplate,
} from '../utils/instruction-file.js';

export interface AutonomyPromptContributorOptions {
  /** Absolute path to the project's `goal.json`. */
  goalPath: string;
  /**
   * Gating function. The contributor consults this on every build and
   * returns an empty array when `false` — without this, the block would
   * leak into interactive runs that happen to have a goal on disk and
   * teach the model loop-control markers it shouldn't emit.
   *
   * Typical wiring: enable while `eternal` or `eternal-parallel` autonomy is
   * active. Receives the build context so the answer can come from the
   * CONVERSATION being built for (`ctx.autonomy`) rather than a process-wide
   * mode ref — with four tabs on one process, that ref is whichever tab last
   * changed it.
   */
  enabled: (ctx: BuildContext) => boolean;
  /** Number of journal entries to include in the recent-tail block. Default 5. */
  journalTailSize?: number | undefined;
}

/**
 * Build a contributor that renders the autonomy-state system block.
 * Returns `[]` when disabled, no goal exists, or the goal has been
 * completed/abandoned — all silent fast-paths.
 */
export function makeAutonomyPromptContributor(
  opts: AutonomyPromptContributorOptions,
): SystemPromptContributor {
  return async (ctx): Promise<TextBlock[]> => {
    // Subagents run a single scoped task and don't drive the engine's
    // outer loop — they have no business emitting `[GOAL_COMPLETE]` or
    // marking todos. Skip the block entirely for subagent prompt builds,
    // mirroring how the active-plan layer is suppressed.
    if (ctx.subagent) return [];
    if (!opts.enabled(ctx)) return [];

    let goal: Awaited<ReturnType<typeof loadGoal>>;
    try {
      goal = await loadGoal(opts.goalPath);
    } catch {
      return [];
    }
    if (!goal) return [];

    // `active` is the default for legacy goal files without the field.
    const missionState = goal.goalState ?? 'active';
    if (missionState !== 'active') return [];

    const tailSize = opts.journalTailSize ?? 5;
    const journalTail = goal.journal.slice(-tailSize).map((e) => {
      const note = e.note ? ` — ${e.note.slice(0, 80)}` : '';
      return `  #${e.iteration} [${e.status}] ${e.task}${note}`;
    });

    const text = renderInstructionTemplate(
      readBundledInstructionText('autonomy/active-mission.md'),
      {
        mission: goal.goal,
        iteration: String(goal.iterations),
        recentJournal:
          journalTail.length > 0
            ? `Recent journal (last ${journalTail.length}):\n${journalTail.join('\n')}`
            : 'Recent journal: (none — this is the first iteration)',
      },
    );

    return [
      {
        type: 'text',
        text,
        cache_control: { type: 'ephemeral' },
      },
    ];
  };
}
