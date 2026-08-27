/**
 * Refusal budget for the completion gate.
 *
 * The gate could say "no" forever. `finalizeTaskCompletion` put a refused card
 * back in `review` and the managed `transitionTask` threw — neither counted
 * anything, so an agent could re-run the same card indefinitely and, on a
 * managed board, nothing downstream of it could ever start. Verification was
 * guarding Done and stalling progress at the same time.
 *
 * This module separates the two. A refusal is counted on the card; when the
 * budget is spent the card is *parked* — durably marked "retrying this
 * unchanged is pointless" — and the worker is free to pick up the next ready
 * card. Parked is not done, not failed, and not abandoned: it is a state a
 * human or a later run can act on, with the refusal's own words attached.
 *
 * Board-kind asymmetry is deliberate. On a legacy board a parked card takes
 * `status: 'blocked'`, which every readiness and queue path already
 * understands. On a managed board status is derived from the lifecycle stage
 * (`STATUS_BY_STAGE`) and `assertManagedTaskPatchAllowed` rejects any
 * out-of-band status write, so the card stays in Review and `task.park` alone
 * carries the signal. Writing `blocked` there would desync stage from column
 * and make `currentManagedStage` throw on the next transition.
 */
import {
  createKanbanEvent,
  emitKanbanEvent,
  findTask,
  nowIso,
  syncTaskColumnForStatus,
} from '../manager/_internal.js';
import { mutateBoard } from '../storage.js';
import type { KanbanBoard, KanbanEventContext, KanbanTask, KanbanTaskPark } from '../types.js';

/**
 * Two, matching the tool-failure rule the agent already follows: two failures
 * in the same place mean the model is wrong, so a third identical attempt is
 * never the answer.
 */
export const DEFAULT_MAX_VERIFICATION_ATTEMPTS = 2;

/** Refusals allowed on one card before it parks. Never below 1. */
export function maxVerificationAttempts(board: KanbanBoard): number {
  const configured = board.completionGate?.maxVerificationAttempts;
  if (configured === undefined || !Number.isFinite(configured)) {
    return DEFAULT_MAX_VERIFICATION_ATTEMPTS;
  }
  return Math.max(1, Math.floor(configured));
}

/**
 * Refusal codes that spend the budget.
 *
 * Deliberately narrow: only refusals the caller cannot talk its way out of on
 * the very next call. A missing `transitionAction`, an exceeded WIP limit or an
 * unmet dependency is a caller-side mistake that the refusal message already
 * tells you how to fix — parking a card for one of those would punish a typo
 * and hide the real instruction. What earns a park is evidence that does not
 * exist: acceptance criteria that will not pass, children that are not done.
 */
const BUDGETED_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'acceptance-criteria-incomplete',
  'parent-child-incomplete',
]);

/** Whether a refused transition counts against the card's refusal budget. */
export function isBudgetedRefusal(
  issues: readonly { code?: string | undefined }[] | undefined,
): boolean {
  return (issues ?? []).some(
    (issue) => issue.code !== undefined && BUDGETED_REFUSAL_CODES.has(issue.code),
  );
}

export interface GateRefusalOutcome {
  /** Refusals counted on this card so far, including the one just recorded. */
  attempts: number;
  /** True when this refusal spent the budget and parked the card. */
  parked: boolean;
  park?: KanbanTaskPark | undefined;
}

export interface GateRefusalInput {
  /** What the gate refused, in the gate's own words. */
  reason: string;
  issues?: readonly string[] | undefined;
}

/**
 * Count one refusal against `task`, parking it when the budget is spent.
 *
 * Mutates in place: every caller already holds the task inside a `mutateBoard`
 * closure, and the alternative — returning a patch for the caller to apply —
 * would let the counter and the park record be persisted separately.
 */
export function applyGateRefusal(
  board: KanbanBoard,
  task: KanbanTask,
  input: GateRefusalInput,
): GateRefusalOutcome {
  const attempts = (task.verificationAttempts ?? 0) + 1;
  task.verificationAttempts = attempts;
  if (attempts < maxVerificationAttempts(board)) {
    // Below budget the card is still live work, so any park from an earlier
    // cycle must not linger and tell the next reader to stop trying.
    delete task.park;
    return { attempts, parked: false };
  }

  const park: KanbanTaskPark = {
    reason: input.reason,
    parkedAt: nowIso(),
    attempts,
    ...(input.issues?.length ? { issues: [...input.issues] } : {}),
  };
  task.park = park;
  if (board.lifecycle?.mode !== 'managed') {
    const previousColumnId = task.columnId;
    task.status = 'blocked';
    delete task.completedAt;
    syncTaskColumnForStatus(board, task, previousColumnId);
  }
  return { attempts, parked: true, park };
}

/**
 * Start the budget over.
 *
 * Called when a card genuinely passes, and available to any path that
 * materially re-scopes a card — a park earned by an old contract must not
 * outlive it.
 */
export function clearGateRefusals(task: KanbanTask): void {
  delete task.verificationAttempts;
  delete task.park;
}

/** Whether retrying this card unchanged is known to be pointless. */
export function isParked(task: KanbanTask): boolean {
  return task.park !== undefined;
}

/**
 * Persist one refusal in its own board write.
 *
 * The managed path needs this because `transitionTask` reports a refused
 * transition by throwing `KanbanLifecycleError` from inside its `mutateBoard`
 * closure — which rolls the whole mutation back, counter included. Callers
 * that catch that error record the refusal here instead. The legacy path has
 * no such problem and uses {@link applyGateRefusal} inline.
 */
export async function recordCompletionRefusal(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: GateRefusalInput & { eventContext: KanbanEventContext },
): Promise<GateRefusalOutcome | null> {
  let outcome: GateRefusalOutcome | null = null;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    outcome = applyGateRefusal(board, task, input);
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    return task;
  });
  if (!updated?.result || !outcome) return null;

  const settled = outcome as GateRefusalOutcome;
  if (settled.parked) {
    await emitKanbanEvent(
      projectRoot,
      createKanbanEvent(boardId, updated.result, 'task.completion.parked', {
        ...input.eventContext,
        after: {
          attempts: settled.attempts,
          reason: settled.park?.reason,
          issues: settled.park?.issues ?? [],
        },
      }),
    );
  }
  return settled;
}
