/**
 * Goal-to-Kanban bridge module.
 *
 * Automatically creates and manages a kanban board for each `/goal set` mission.
 * The board mirrors the goal's deliverables as tasks flowing through
 * Backlog → In Progress → Done columns, and the autonomy engines update
 * task status as work progresses.
 *
 * API:
 *   createGoalKanbanBoard(projectRoot, goalFile, goalId) → boardId
 *   findGoalKanbanBoard(projectRoot, boardId)           → KanbanBoard | null
 *   deleteGoalKanbanBoard(projectRoot, boardId)         → void
 *   formatGoalKanbanPreview(goalFile)                   → string (rich display)
 *   formatGoalKanbanChoicePrompt()                      → string (selection screen)
 */

import { color } from '../utils/color.js';
import { boardStore, tryBoardStore } from './board-store-port.js';
import type { GoalFile } from './goal-store.js';

// ── Constants ───────────────────────────────────────────────────────────────

const GOAL_BOARD_TAG_PREFIX = 'goal:';

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create (or update) a kanban board for the given goal.
 *
 * - If the goal file already carries a `kanbanBoardId` and the board still
 *   exists, this is a no-op (returns the existing id).
 * - Otherwise a new board is created with three columns and one task per
 *   deliverable. The board id is stored on `goalFile.kanbanBoardId`.
 *
 * Returns the board id. Returns null when the project root is unavailable.
 *
 * `sessionId` is the session that set the goal: the deliverable tasks it seeds
 * are durable board events, and they belong to that session.
 */
export async function createGoalKanbanBoard(
  projectRoot: string,
  goalFile: GoalFile,
  sessionId: string,
): Promise<string | null> {
  if (!projectRoot) return null;

  // Fail soft when the port is unwired (non-CLI embeddings): behave as if
  // no kanban backend exists instead of throwing through the .catch chains.
  const store = tryBoardStore();
  if (!store) return null;

  // Reuse an existing link if the board is still alive
  const existingId = (goalFile as GoalFileWithKanban).kanbanBoardId;
  if (existingId) {
    const existing = await store.getBoard(projectRoot, existingId).catch(() => null);
    if (existing) return existingId;
  }

  // Build a short goal suffix for the board title (max ~60 chars)
  const displayGoal = (goalFile.refinedGoal || goalFile.goal).replace(/\s+/g, ' ').trim();
  const titleSuffix = displayGoal.length > 80 ? displayGoal.slice(0, 77) + '…' : displayGoal;

  const board = await store.createBoard(projectRoot, {
    title: `🎯 ${titleSuffix}`,
    description: `Kanban board auto-created for goal: ${displayGoal}`,
    tags: [goalTag(goalFile)],
    // Goal boards mirror an engine-driven run; the goal coordinator owns
    // completion semantics, so the kanban completion gate stays out of the way.
    completionGate: { enforcement: 'off' },
  });

  // The board is created with the kanban package's default columns (Backlog,
  // To Do, In Progress, Review, Done) which already cover the goal workflow.

  // Add one task per deliverable, each tagged with origin
  // so refreshGoalKanban() can match by stable ID instead of title text.
  const targetColumnId = board.columns[0]?.id ?? 'backlog';
  if (goalFile.deliverables && goalFile.deliverables.length > 0) {
    for (let index = 0; index < goalFile.deliverables.length; index++) {
      const d = goalFile.deliverables[index]!;
      const cleaned = d.replace(/^\[[x✓]\]|✅|\(done\)\s*/i, '').trim();
      if (cleaned) {
        await store
          .addTask(
            projectRoot,
            board.id,
            {
              title: cleaned,
              columnId: targetColumnId,
              description: `Deliverable for goal: ${displayGoal}`,
              priority: 'medium',
              origin: {
                system: 'goal',
                taskId: `deliverable:${index}`,
              },
            },
            { sessionId, actor: 'goal' },
          )
          .catch(() => {
            // Best-effort: a task-add failure for one deliverable won't crash the goal
          });
      }
    }
  }

  // Store the board id on the goal file by mutating the passed reference
  (goalFile as GoalFileWithKanban).kanbanBoardId = board.id;

  return board.id;
}

/**
 * Find a kanban board by id. Returns null when the board doesn't exist
 * (e.g. manually deleted). The caller should handle this gracefully.
 */
export async function findGoalKanbanBoard(projectRoot: string, boardId: string) {
  if (!projectRoot || !boardId) return null;
  try {
    return await boardStore().getBoard(projectRoot, boardId);
  } catch {
    return null;
  }
}

/**
 * Delete the kanban board linked to a goal. Best-effort.
 */
export async function deleteGoalKanbanBoard(projectRoot: string, boardId: string): Promise<void> {
  if (!projectRoot || !boardId) return;
  const store = tryBoardStore();
  if (!store) return;
  await store.removeBoard(projectRoot, boardId).catch(() => {});
}

/**
 * Find a goal-linked kanban board by its goal tag.
 * Used when the goal file's kanbanBoardId is missing but the board exists.
 */
export async function findGoalBoardByTag(projectRoot: string, goalFile: GoalFile) {
  if (!projectRoot) return null;
  const store = tryBoardStore();
  if (!store) return null;
  const tag = goalTag(goalFile);
  const boards = await store.listBoards(projectRoot);
  const matched = boards.find((b) => b.tags?.includes(tag));
  if (!matched) return null;
  return store.getBoard(projectRoot, matched.id).catch(() => null);
}

/**
 * Build a formatted "Goal Kanban" preview block showing deliverables as
 * a kanban-column layout. This is the "Goal event" displayed after the
 * deliverables list.
 */
export function formatGoalKanbanPreview(
  goalFile: GoalFile,
  boardId?: string | null,
  taskCount?: number,
): string {
  const lines: string[] = [];
  const displayGoal = (goalFile.refinedGoal || goalFile.goal).replace(/\s+/g, ' ').trim();

  // ── Header ──
  lines.push('');
  lines.push(color.bold(color.cyan('═══════════════════════════════════════')));
  lines.push(color.bold(color.cyan('  🎯 GOAL KANBAN — Mission Board')));
  lines.push(color.bold(color.cyan('═══════════════════════════════════════')));
  lines.push('');
  lines.push(`  ${color.bold('Mission:')} ${color.bold(displayGoal)}`);
  if (boardId) {
    lines.push(`  ${color.dim(`Board: ${boardId.slice(0, 12)}…`)}`);
  }
  if (typeof taskCount === 'number') {
    lines.push(`  ${color.dim(`${taskCount} task(s)`)}`);
  }
  lines.push('');

  // ── Deliverables as kanban columns ──
  const deliverables = goalFile.deliverables ?? [];
  const doneDeliverables = deliverables.filter((d) => /^\[[x✓]\]|✅|\(done\)/i.test(d)).length;
  const totalDeliverables = deliverables.length;

  if (totalDeliverables > 0) {
    // Backlog section (todo items)
    const backlog = deliverables.filter((d) => !/^\[[x✓]\]|✅|\(done\)|🔄|in.progress/i.test(d));
    const inProgress = deliverables.filter((d) => /🔄|in.progress/i.test(d));
    const done = deliverables.filter((d) => /^\[[x✓]\]|✅|\(done\)/i.test(d));

    const renderColumn = (
      title: string,
      items: string[],
      icon: string,
      accent: (s: string) => string,
    ) => {
      if (items.length === 0) {
        lines.push(`  ${accent(color.bold(`${icon} ${title}`))}  ${color.dim('(empty)')}`);
        return;
      }
      lines.push(`  ${accent(color.bold(`${icon} ${title} (${items.length})`))}`);
      for (const item of items) {
        const cleaned = item.replace(/^\[[x✓]\]|✅|\(done\)|🔄|in.progress\s*/gi, '').trim();
        lines.push(`    ○ ${cleaned}`);
      }
    };

    renderColumn('Backlog', backlog, '📋', (s) => color.dim(s));
    renderColumn('In Progress', inProgress, '🔄', (s) => color.cyan(s));
    renderColumn('Done', done, '✅', (s) => color.green(s));

    lines.push('');
    lines.push(
      `  ${color.dim(`Progress: ${doneDeliverables}/${totalDeliverables} deliverables complete`)}`,
    );
  }

  // ── Progress bar (when available) ──
  if (typeof goalFile.progress === 'number') {
    const pct = Math.min(100, Math.max(0, Math.round(goalFile.progress)));
    const filled = Math.round(pct / 5);
    const empty = 20 - filled;
    const bar = color.green('█'.repeat(filled)) + color.dim('░'.repeat(empty));
    lines.push(`  ${color.dim('Overall:')} ${bar} ${color.bold(`${pct}%`)}`);
    if (goalFile.progressNote) {
      lines.push(`  ${color.dim(goalFile.progressNote)}`);
    }
  }
  if (typeof goalFile.progress === 'undefined' && totalDeliverables > 0) {
    const pct = Math.round((doneDeliverables / totalDeliverables) * 100);
    const filled = Math.round(pct / 5);
    const empty = 20 - filled;
    const bar = (pct > 0 ? color.green('█'.repeat(filled)) : '') + color.dim('░'.repeat(empty));
    lines.push(`  ${color.dim('Overall:')} ${bar} ${color.bold(`${pct}%`)}`);
  }

  lines.push('');
  lines.push(color.bold(color.cyan('═══════════════════════════════════════')));

  return lines.join('\n');
}

/**
 * Build the "Goal event" banner — shown after deliverables in `/goal set`.
 * A compact, visually rich summary that doubles as the "goal event" trigger.
 */
export function formatGoalEvent(goalFile: GoalFile, boardId?: string | null): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(color.bold(color.green('┌─── Goal Event ───────────────────────────────┐')));
  lines.push(color.bold(color.green('│')) + '  🎯 Mission locked and ready');
  if (boardId) {
    lines.push(
      color.bold(color.green('│')) +
        `  📋 Kanban board created: ${color.cyan(boardId.slice(0, 12) + '…')}`,
    );
  }
  const deliverables = goalFile.deliverables ?? [];
  lines.push(
    color.bold(color.green('│')) +
      `  📦 ${deliverables.length} deliverable${deliverables.length !== 1 ? 's' : ''} extracted`,
  );
  if (typeof goalFile.progress === 'number') {
    lines.push(color.bold(color.green('│')) + `  📊 Progress: ${goalFile.progress}%`);
  }
  lines.push(color.bold(color.green('└────────────────────────────────────────────┘')));

  return lines.join('\n');
}

/**
 * Build the autonomy choice prompt — shown after the goal event.
 * Presents the user with two modes and asks for a selection.
 */
export function formatGoalAutonomyChoice(): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(color.bold(color.magenta('═══ Choose Autonomy Mode ═══')));
  lines.push('');
  lines.push(
    `  ${color.bold('1')}. ${color.red('Autonomy Eternal')}` +
      `  ${color.dim('— Single-agent sense/decide/execute/reflect loop')}`,
  );
  lines.push(
    `  ${color.bold('2')}. ${color.magenta('Eternal Parallel')}` +
      `  ${color.dim('— Multi-agent fan-out (4-8 subagents per tick)')}`,
  );
  lines.push('');
  lines.push(`  ${color.dim('Enter 1 or 2 (or press Enter to skip):')}`);

  return lines.join('\n');
}

/**
 * Parse a user choice for autonomy mode.
 * Returns 'eternal' | 'eternal-parallel' | null (skip).
 */
export function parseAutonomyChoice(input: string): 'eternal' | 'eternal-parallel' | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '1' || trimmed === 'eternal' || trimmed === 'e') return 'eternal';
  if (trimmed === '2' || trimmed === 'parallel' || trimmed === 'p') return 'eternal-parallel';
  if (trimmed === '' || trimmed === 'skip' || trimmed === 's' || trimmed === '0') return null;
  return null;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function goalTag(goalFile: GoalFile): string {
  // Use the goal's first 24 chars as a stable tag component
  const goal = (goalFile.refinedGoal || goalFile.goal)
    .replace(/\s+/g, '-')
    .slice(0, 24)
    .toLowerCase();
  return `${GOAL_BOARD_TAG_PREFIX}${goal}`;
}

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Extended GoalFile with optional kanban board reference.
 */
export interface GoalFileWithKanban extends GoalFile {
  kanbanBoardId?: string | undefined;
}
