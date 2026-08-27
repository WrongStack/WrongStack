import type { BrainArbiter } from '../coordination/brain.js';
import { boardStore } from './board-store-port.js';
import type { EventBus } from './event-bus-port.js';
import { findGoalBoardByTag, findGoalKanbanBoard, type GoalFileWithKanban } from './goal-kanban.js';
import { appendJournal, type GoalFile, loadGoal, recordProgress, saveGoal } from './goal-store.js';

const DONE_MARKER = /\[done:\s*([^\]]+)\]/gi;
const DONE_PREFIX = /^\s*(?:✅|\[[x✓]\]|\(done\))\s*/i;

export interface CompletedGoalDeliverable {
  index: number;
  text: string;
}

export interface GoalCoordinationResult {
  goal: GoalFile;
  completed: CompletedGoalDeliverable[];
  kanbanUpdatedTaskIds: string[];
  reached: boolean;
}

export interface CoordinateGoalIterationOptions {
  projectRoot: string;
  goalPath: string;
  finalText: string;
  brain?: BrainArbiter | undefined;
  /**
   * Session running this autonomy iteration. Required: closing a deliverable
   * writes durable Kanban events, and those are attributed to the session that
   * produced the `[DONE:]` marker.
   */
  sessionId: string;
  events?: EventBus | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Parse optional `[DONE: index]` / `[DONE: text-prefix]` markers emitted by an
 * autonomy iteration. Numeric indices are human-facing and therefore 1-based;
 * `0` is accepted as an explicit first-item alias for backwards compatibility.
 */
export function parseCompletedGoalDeliverables(
  finalText: string,
  deliverables: readonly string[],
): CompletedGoalDeliverable[] {
  if (!finalText || deliverables.length === 0) return [];
  const seen = new Set<number>();
  const completed: CompletedGoalDeliverable[] = [];

  for (const match of finalText.matchAll(DONE_MARKER)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const numeric = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined;
    let index = numeric === undefined ? -1 : numeric === 0 ? 0 : numeric - 1;
    if (index < 0 || index >= deliverables.length) {
      const prefix = raw.toLowerCase();
      index = deliverables.findIndex((item) =>
        stripGoalDeliverableMarker(item).toLowerCase().startsWith(prefix),
      );
    }
    if (index < 0 || index >= deliverables.length || seen.has(index)) continue;
    const source = deliverables[index] ?? '';
    if (isGoalDeliverableComplete(source)) continue;
    seen.add(index);
    completed.push({ index, text: stripGoalDeliverableMarker(source) });
  }
  return completed;
}

export function isGoalDeliverableComplete(value: string): boolean {
  return DONE_PREFIX.test(value);
}

export function stripGoalDeliverableMarker(value: string): string {
  return value.replace(DONE_PREFIX, '').trim();
}

/** Mark newly completed deliverables and recompute progress from the checklist. */
export function applyGoalDeliverableCompletions(
  goal: GoalFile,
  completed: readonly CompletedGoalDeliverable[],
): GoalFile {
  if (completed.length === 0) return recomputeGoalProgress(goal);
  const completedIndices = new Set(completed.map((item) => item.index));
  let next: GoalFile = {
    ...goal,
    deliverables: (goal.deliverables ?? []).map((item, index) =>
      completedIndices.has(index) && !isGoalDeliverableComplete(item) ? `✅ ${item}` : item,
    ),
  };
  next = appendGoalDeliverableJournals(next, completed);
  return recomputeGoalProgress(next);
}

function appendGoalDeliverableJournals(
  goal: GoalFile,
  completed: readonly CompletedGoalDeliverable[],
): GoalFile {
  let next = goal;
  for (const item of completed) {
    next = appendJournal(next, {
      source: 'deliverable',
      task: `Deliverable completed: ${item.text}`.slice(0, 240),
      status: 'success',
      note: `[DONE: ${item.index + 1}]`,
    });
  }
  return next;
}

export function recomputeGoalProgress(goal: GoalFile): GoalFile {
  const deliverables = goal.deliverables ?? [];
  if (deliverables.length === 0) return goal;
  const done = deliverables.filter(isGoalDeliverableComplete).length;
  const progress = Math.round((done / deliverables.length) * 100);
  return recordProgress(goal, progress, `${done}/${deliverables.length} deliverables complete`);
}

/**
 * Close the marker → Kanban → progress → Brain loop and persist the resulting
 * goal state. Brain is called exactly once, and only when every deliverable is
 * complete. A missing/negative Brain leaves the goal active at 100%.
 */
export async function coordinateGoalIteration(
  options: CoordinateGoalIterationOptions,
): Promise<GoalCoordinationResult | null> {
  const current = await loadGoal(options.goalPath, options.events);
  if (!current) return null;

  const completed = parseCompletedGoalDeliverables(options.finalText, current.deliverables ?? []);
  const board = await resolveGoalBoard(options.projectRoot, current);
  let kanbanUpdatedTaskIds: string[] = [];
  let goal: GoalFile;
  if (board) {
    // Kanban owns durable deliverable status. Marker output is a requested
    // transition; goal.json is rebuilt from the committed board state.
    kanbanUpdatedTaskIds = await refreshGoalKanban(
      options.projectRoot,
      current,
      completed,
      options.sessionId,
      board,
    );
    goal = await recomputeGoalProgressFromKanban(options.projectRoot, current);
    const confirmed = completed.filter(
      (item) =>
        !isGoalDeliverableComplete(current.deliverables?.[item.index] ?? '') &&
        isGoalDeliverableComplete(goal.deliverables?.[item.index] ?? ''),
    );
    goal = appendGoalDeliverableJournals(goal, confirmed);
  } else {
    // Pre-Kanban goals keep their existing file-backed checklist semantics.
    goal = applyGoalDeliverableCompletions(current, completed);
  }

  let reached = false;
  const allComplete =
    (goal.deliverables?.length ?? 0) > 0 &&
    goal.deliverables?.every(isGoalDeliverableComplete) === true;
  if (allComplete && options.brain) {
    const decision = await options.brain.decide({
      id: `goal-reached-${goal.iterations}`,
      sessionId: options.sessionId,
      source: 'system',
      question: 'Have all goal deliverables been reached and verified?',
      context: [
        `Goal: ${goal.refinedGoal ?? goal.goal}`,
        `Progress: ${goal.progress ?? 0}%`,
        'Completed deliverables:',
        ...(goal.deliverables ?? []).map(
          (item, index) => `${index + 1}. ${stripGoalDeliverableMarker(item)}`,
        ),
      ].join('\n'),
      risk: 'high',
      fallback: 'continue',
      options: [
        {
          id: 'goal_reached',
          label: 'Goal reached',
          consequence: 'Persist the completed goal and stop the eternal loop.',
        },
        {
          id: 'keep_working',
          label: 'Keep working',
          consequence: 'Leave the goal active for another iteration.',
        },
      ],
    });
    reached = decision.type === 'answer' && decision.optionId === 'goal_reached';
  }

  if (reached) {
    const reachedAt = (options.now?.() ?? new Date()).toISOString();
    goal = appendJournal(
      {
        ...goal,
        goalState: 'completed',
        engineState: 'stopped',
        progress: 100,
        progressNote: 'goal reached',
        reachedAt,
        reachedNote: 'goal reached',
      },
      {
        source: 'deliverable',
        task: 'GOAL REACHED',
        status: 'success',
        note: 'goal reached',
      },
    );
  }
  await saveGoal(options.goalPath, goal, options.events);
  return { goal, completed, kanbanUpdatedTaskIds, reached };
}

async function resolveGoalBoard(projectRoot: string, goal: GoalFile) {
  const boardId = (goal as GoalFileWithKanban).kanbanBoardId;
  if (boardId) {
    const board = await findGoalKanbanBoard(projectRoot, boardId);
    if (board) return board;
  }
  return findGoalBoardByTag(projectRoot, goal);
}

async function refreshGoalKanban(
  projectRoot: string,
  goal: GoalFile,
  completed: readonly CompletedGoalDeliverable[],
  sessionId: string,
  resolvedBoard?: Awaited<ReturnType<typeof resolveGoalBoard>>,
): Promise<string[]> {
  if (completed.length === 0) return [];
  const board = resolvedBoard ?? (await resolveGoalBoard(projectRoot, goal));
  if (!board) return [];
  const doneColumn = board.columns.find((column) => column.title.toLowerCase() === 'done');
  if (!doneColumn) return [];

  // Build a set of deliverable origin keys from completed items.
  // Each item carries its index in the deliverables array, which matches
  // the `deliverable:${index}` origin.taskId set at board creation time.
  const originKeys = new Set(completed.map((item) => `deliverable:${item.index}`));

  // Build title-based fallback set for boards created before origin tracking.
  const completedTitles = new Set(completed.map((item) => normalizeTitle(item.text)));

  const updated: string[] = [];
  for (const task of board.tasks) {
    // Prefer origin-based matching (stable) over title-based (fragile).
    const originMatch =
      task.origin?.system === 'goal' && task.origin?.taskId
        ? originKeys.has(task.origin.taskId)
        : false;
    const titleMatch = !task.origin?.taskId && completedTitles.has(normalizeTitle(task.title));
    if (!originMatch && !titleMatch) continue;
    const result = await boardStore().updateTask(
      projectRoot,
      board.id,
      task.id,
      { columnId: doneColumn.id, status: 'completed' },
      {
        sessionId,
        actor: 'goal-coordinator',
        note: originMatch
          ? `deliverable-completed: Matched by origin ${task.origin!.taskId}.`
          : 'deliverable-completed: Updated from [DONE:] marker (title fallback).',
      },
    );
    if (result) updated.push(task.id);
  }
  return updated;
}

async function recomputeGoalProgressFromKanban(
  projectRoot: string,
  goal: GoalFile,
): Promise<GoalFile> {
  const board = await resolveGoalBoard(projectRoot, goal);
  if (!board || !goal.deliverables?.length) return recomputeGoalProgress(goal);
  const tasksByOrigin = new Map(
    board.tasks
      .filter((task) => task.origin?.system === 'goal' && task.origin.taskId)
      .map((task) => [task.origin!.taskId!, task]),
  );
  const completedLegacyTitles = new Set(
    board.tasks
      .filter((task) => !task.origin?.taskId && task.status === 'completed')
      .map((task) => normalizeTitle(task.title)),
  );
  const deliverables = goal.deliverables.map((item, index) => {
    const text = stripGoalDeliverableMarker(item);
    const originTask = tasksByOrigin.get(`deliverable:${index}`);
    const complete = originTask
      ? originTask.status === 'completed'
      : completedLegacyTitles.has(normalizeTitle(text)) || isGoalDeliverableComplete(item);
    return complete ? `✅ ${text}` : text;
  });
  return recomputeGoalProgress({ ...goal, deliverables });
}

function normalizeTitle(value: string): string {
  return stripGoalDeliverableMarker(value).replace(/\s+/g, ' ').trim().toLowerCase();
}
