import { randomUUID } from 'node:crypto';
import { assertManagementWrite } from '../management-fence.js';
import { mutateBoard } from '../storage.js';
import type {
  KanbanBoard,
  KanbanCheck,
  KanbanCheckStatus,
  KanbanEvent,
  KanbanEventContext,
} from '../types.js';
import { clearGateRefusals } from '../verification/refusal-budget.js';
import { stampAtomicityAssessment } from './_internal.js';
import { nowIso } from './basic-helpers.js';
import { createKanbanEvent, emitKanbanEvent } from './board-events.js';
import { assertAcceptedContractUnchanged } from './lifecycle/accepted-contract.js';
import { findTask } from './task-lookup.js';

const VALID_CHECK_STATUSES: ReadonlySet<KanbanCheckStatus> = new Set([
  'pending',
  'passed',
  'failed',
  'skipped',
]);

export async function addCheckToTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  check: Omit<KanbanCheck, 'id' | 'status'> & { status?: KanbanCheckStatus | undefined },
  eventContext: KanbanEventContext,
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    assertManagementWrite(board, [task], eventContext);
    if (eventContext.expectedManagementToken !== undefined) {
      if (check.status !== undefined && check.status !== 'pending')
        throw new Error('Kanban manager acceptance checks must be pending.');
      const existing = task.successCriteria?.find(
        (item) => item.description.trim() === check.description.trim() && item.type === check.type,
      );
      if (existing) return existing;
    }
    const newCheck: KanbanCheck = {
      id: randomUUID(),
      description: check.description,
      type: check.type,
      status: check.status ?? 'pending',
      ...(check.checkedBy !== undefined ? { checkedBy: check.checkedBy } : {}),
      ...(check.checkedAt !== undefined ? { checkedAt: check.checkedAt } : {}),
      ...(check.notes !== undefined ? { notes: check.notes } : {}),
      ...(check.escalation !== undefined ? { escalation: check.escalation } : {}),
    };
    const criteria = [...(task.successCriteria ?? []), newCheck];
    assertAcceptedContractUnchanged(board, task, { ...task, successCriteria: criteria });
    task.successCriteria = criteria;
    delete task.verificationReport;
    stampAtomicityAssessment(board, task);
    // The card is now held to something it was not held to when the gate
    // refused it, so the refusal budget starts over.
    clearGateRefusals(task, board);
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    event = createKanbanEvent(board.id, task, 'task.check.added', {
      ...eventContext,
      after: { ...newCheck },
    });
    return newCheck;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function updateCheckOnTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  checkId: string,
  patch: Partial<Omit<KanbanCheck, 'id'>>,
  eventContext: KanbanEventContext,
): Promise<KanbanBoard | null> {
  // The TypeScript type is not enforced across the IPC boundary; an unvalidated
  // caller can set check.status to an arbitrary string, after which the Done
  // gate (validateDefinitionOfDone) refuses Done forever because it treats any
  // non-'passed' value as unmet. Reject an unknown status before persisting.
  if (patch.status !== undefined && !VALID_CHECK_STATUSES.has(patch.status)) {
    return null;
  }
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    const check = task?.successCriteria?.find((candidate) => candidate.id === checkId);
    if (!task || !check) return null;
    assertManagementWrite(board, [task], eventContext);
    const before = { ...check };
    const acceptedTask = structuredClone(task);
    // Untyped/structural patches can carry id despite Omit; references must stay stable.
    Object.assign(check, patch, { id: before.id });
    assertAcceptedContractUnchanged(board, acceptedTask, task);
    const definitionChanged =
      check.description !== before.description ||
      check.type !== before.type ||
      check.notes !== before.notes ||
      check.escalation !== before.escalation;
    if (definitionChanged) {
      // A converted check is a new assertion: the persisted status and audit
      // trail belong to the OLD type (e.g. a failed command run must not
      // keep failing the manual check it never applied to). An explicit
      // status patch still wins; otherwise the check resets to pending.
      if (patch.status === undefined) check.status = 'pending';
      check.checkedAt = patch.checkedAt;
      check.checkedBy = patch.checkedBy;
      delete task.verificationReport;
      stampAtomicityAssessment(board, task);
    }
    if (patch.status && patch.status !== 'pending' && !check.checkedAt) {
      check.checkedAt = nowIso();
    }
    // Rewriting what a criterion ASSERTS re-scopes the card, so the refusal
    // budget starts over. Ticking a criterion's status does not: that is the
    // ordinary verification flow, and resetting there would hand the card an
    // unlimited budget and make the gate unable to ever park anything.
    if (definitionChanged) {
      clearGateRefusals(task, board);
    }
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    event = createKanbanEvent(board.id, task, 'task.check.updated', {
      ...eventContext,
      before,
      after: { ...check },
    });
    return check;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

/**
 * Drop an acceptance criterion.
 *
 * The counterpart to `addCheckToTask` was missing, and its absence was a dead
 * end rather than an inconvenience: `validateDefinitionOfDone` refuses Done
 * while ANY criterion is not `passed`, so a criterion that turned out to be
 * irrelevant — or one recorded as `skipped` — held its card out of Done
 * permanently, and the only way past was to mark it `passed`, which is a lie.
 * Removing the criterion is the truthful escape.
 *
 * The contract map may bind a verification node to a criterion, so clear that
 * binding too rather than leaving a node pointing at an id that no longer
 * exists.
 */
export async function removeCheckFromTask(
  projectRoot: string,
  boardId: string,
  taskId: string,
  checkId: string,
  eventContext: KanbanEventContext,
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    const index = task?.successCriteria?.findIndex((candidate) => candidate.id === checkId) ?? -1;
    if (!task || index === -1) return null;
    assertManagementWrite(board, [task], eventContext);
    assertAcceptedContractUnchanged(board, task, {
      ...task,
      successCriteria: task.successCriteria!.filter((_, position) => position !== index),
    });
    const [removed] = task.successCriteria!.splice(index, 1);
    if (task.successCriteria!.length === 0) delete task.successCriteria;
    delete task.verificationReport;
    stampAtomicityAssessment(board, task);
    // Dropping a criterion is the truthful escape this function exists for
    // (see above). Leaving a spent budget behind would defeat it: the card
    // would re-park on its very next refusal.
    clearGateRefusals(task, board);
    for (const node of board.contractGraph?.nodes ?? []) {
      if (node.checkId === checkId) delete node.checkId;
    }
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    event = createKanbanEvent(board.id, task, 'task.check.removed', {
      ...eventContext,
      before: removed,
    });
    return removed;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}
