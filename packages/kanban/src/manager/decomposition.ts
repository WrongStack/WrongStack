/**
 * Decomposition proposal lifecycle.
 *
 * Proposals live ON the task (`task.decomposition`) so every `{board}`
 * broadcast carries the full approval state — no side-channel storage.
 *
 *   proposeTaskDecomposition: records a proposal; in 'auto' mode it is applied
 *     immediately (splitTask with per-child specs, parent.atomic=true).
 *   resolveDecompositionProposal: approve (apply the split) or reject.
 *
 * Events: task.decomposition.proposed / task.decomposition.applied /
 * task.decomposition.rejected (existing task.split still fires on apply).
 */

import { randomUUID } from 'node:crypto';
import { mutateBoard } from '../storage.js';
import type {
  KanbanBoard,
  KanbanCheck,
  KanbanDecompositionProposal,
  KanbanDecompositionSubtask,
  KanbanEventContext,
  KanbanTask,
} from '../types.js';
import {
  createKanbanEvent,
  emitKanbanEvent,
  findTask,
  hasDependencyPath,
  nowIso,
} from './_internal.js';
import { splitTask } from './dependencies.js';

export interface ProposeTaskDecompositionInput {
  subtasks: KanbanDecompositionSubtask[];
  rationale?: string | undefined;
  /** Override the board policy's decomposition mode for this proposal. */
  mode?: 'auto' | 'approval' | undefined;
  proposedBy?: string | undefined;
}

export interface ResolveDecompositionInput {
  action: 'approve' | 'reject';
  reason?: string | undefined;
  /** Approve with edits: replaces the proposal's subtasks before applying. */
  editedSubtasks?: KanbanDecompositionSubtask[] | undefined;
  resolvedBy?: string | undefined;
}

function checksFromCriteria(criteria: string[] | undefined): KanbanCheck[] | undefined {
  if (!criteria?.length) return undefined;
  return criteria.map((description) => {
    // A marker alone (for example "$ ") has no executable body and remains
    // manual; classifying it as a command would only produce a verifier error.
    const commandMatch = /^\s*(?:\$\s+|(?:run|verify|cmd)\s*:\s*)(.+)$/i.exec(description);
    return {
      id: randomUUID(),
      description,
      // The command verifier consumes notes first, keeping the marker out of execution.
      ...(commandMatch?.[1] ? { notes: commandMatch[1].trim() } : {}),
      type: commandMatch ? ('command' as const) : ('manual' as const),
      status: 'pending' as const,
    };
  });
}

/** Apply an approved proposal's subtasks via splitTask (single code path). */
async function applyProposal(
  projectRoot: string,
  boardId: string,
  taskId: string,
  subtasks: KanbanDecompositionSubtask[],
): Promise<{ board: KanbanBoard; parent: KanbanTask; children: KanbanTask[] } | null> {
  return splitTask(projectRoot, boardId, taskId, {
    titles: subtasks.map((subtask) => subtask.title),
    childSpecs: subtasks.map((subtask) => {
      const successCriteria = checksFromCriteria(subtask.successCriteria);
      return {
        ...(subtask.description !== undefined ? { description: subtask.description } : {}),
        ...(successCriteria ? { successCriteria } : {}),
        ...(subtask.expectedFileChanges !== undefined
          ? { expectedFileChanges: subtask.expectedFileChanges }
          : {}),
      };
    }),
    // Proactive decomposition always opts the parent into subtree verification.
    atomic: true,
  });
}

/** Wire intra-proposal dependsOnIndex edges onto the created children. */
async function wireProposalDependencies(
  projectRoot: string,
  boardId: string,
  subtasks: KanbanDecompositionSubtask[],
  childIds: string[],
): Promise<void> {
  const edges: Array<{ taskId: string; dependsOn: string[] }> = [];
  subtasks.forEach((subtask, index) => {
    const childId = childIds[index];
    if (!childId || !subtask.dependsOnIndex?.length) return;
    const dependsOn = subtask.dependsOnIndex
      .map((depIndex) => childIds[depIndex])
      .filter((id): id is string => Boolean(id) && id !== childId);
    if (dependsOn.length) edges.push({ taskId: childId, dependsOn });
  });
  if (!edges.length) return;
  await mutateBoard(projectRoot, boardId, (board) => {
    for (const edge of edges) {
      const child = findTask(board, edge.taskId);
      if (!child) continue;
      // The dependsOnIndex edges come from the MODEL's proposal — a mutual
      // pair (A dependsOn B, B dependsOn A) is one hallucination away, and
      // this loop used to write it verbatim: both children became forever
      // unclaimable AND every later syncBoardFromTaskGraph threw on the
      // cycle, poisoning the board. Add each edge only if the reverse path
      // does not already exist; a dropped edge degrades to "may run in
      // either order", which is strictly better than a dead board.
      for (const dependencyId of edge.dependsOn) {
        if (hasDependencyPath(board, dependencyId, edge.taskId)) continue;
        child.dependsOn = [...new Set([...(child.dependsOn ?? []), dependencyId])];
      }
    }
    board.updatedAt = nowIso();
    return true;
  });
}

export async function proposeTaskDecomposition(
  projectRoot: string,
  boardId: string,
  taskId: string,
  input: ProposeTaskDecompositionInput,
  eventContext: KanbanEventContext = {},
): Promise<{ board: KanbanBoard; task: KanbanTask; proposal: KanbanDecompositionProposal } | null> {
  if (input.subtasks.length < 2) {
    throw new Error('A decomposition proposal requires at least two subtasks.');
  }

  // Resolve the effective mode from the board policy when not overridden.
  let resolvedMode: 'auto' | 'approval' = input.mode ?? 'approval';
  const seeded = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task) return null;
    if (input.mode === undefined) {
      resolvedMode = board.atomicity?.decomposition === 'auto' ? 'auto' : 'approval';
    }
    const proposal: KanbanDecompositionProposal = {
      id: randomUUID(),
      taskId: task.id,
      status: 'proposed',
      mode: resolvedMode,
      proposedSubtasks: input.subtasks.map((subtask) => ({ ...subtask })),
      proposedAt: nowIso(),
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      ...(input.proposedBy !== undefined ? { proposedBy: input.proposedBy } : {}),
    };
    task.decomposition = proposal;
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    return { task, proposal };
  });
  if (!seeded?.result) return null;

  await emitKanbanEvent(
    projectRoot,
    createKanbanEvent(seeded.board.id, seeded.result.task, 'task.decomposition.proposed', {
      ...eventContext,
      after: {
        proposalId: seeded.result.proposal.id,
        mode: resolvedMode,
        subtasks: seeded.result.proposal.proposedSubtasks.map((subtask) => ({
          title: subtask.title,
          ...(subtask.successCriteria?.length ? { successCriteria: subtask.successCriteria } : {}),
        })),
        ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      },
    }),
  );

  if (resolvedMode === 'auto') {
    return resolveDecompositionProposal(
      projectRoot,
      boardId,
      taskId,
      seeded.result.proposal.id,
      { action: 'approve', resolvedBy: input.proposedBy ?? 'auto' },
      eventContext,
    );
  }
  return { board: seeded.board, task: seeded.result.task, proposal: seeded.result.proposal };
}

export async function resolveDecompositionProposal(
  projectRoot: string,
  boardId: string,
  taskId: string,
  proposalId: string,
  input: ResolveDecompositionInput,
  eventContext: KanbanEventContext = {},
): Promise<{ board: KanbanBoard; task: KanbanTask; proposal: KanbanDecompositionProposal } | null> {
  // Phase 1: validate + (reject | mark approved) inside the lock.
  const marked = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task?.decomposition || task.decomposition.id !== proposalId) return null;
    if (task.decomposition.status !== 'proposed') return null;
    const now = nowIso();
    if (input.editedSubtasks?.length) {
      if (input.editedSubtasks.length < 2) {
        throw new Error('An edited decomposition still requires at least two subtasks.');
      }
      task.decomposition.proposedSubtasks = input.editedSubtasks.map((subtask) => ({
        ...subtask,
      }));
    }
    task.decomposition.status = input.action === 'approve' ? 'approved' : 'rejected';
    task.decomposition.resolvedAt = now;
    if (input.resolvedBy !== undefined) task.decomposition.resolvedBy = input.resolvedBy;
    if (input.reason !== undefined) task.decomposition.resolutionReason = input.reason;
    task.updatedAt = now;
    board.updatedAt = now;
    return { task, proposal: task.decomposition };
  });
  if (!marked?.result) return null;

  if (input.action === 'reject') {
    await emitKanbanEvent(
      projectRoot,
      createKanbanEvent(marked.board.id, marked.result.task, 'task.decomposition.rejected', {
        ...eventContext,
        ...(input.reason !== undefined ? { note: input.reason } : {}),
        after: { proposalId },
      }),
    );
    return { board: marked.board, task: marked.result.task, proposal: marked.result.proposal };
  }

  // Phase 2: apply the approved split (its own mutations; splitTask emits task.split).
  const subtasks = marked.result.proposal.proposedSubtasks;
  const applied = await applyProposal(projectRoot, boardId, taskId, subtasks);
  if (!applied) return null;
  await wireProposalDependencies(
    projectRoot,
    boardId,
    subtasks,
    applied.children.map((child) => child.id),
  );

  // Phase 3: stamp applied state on the proposal.
  const stamped = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, taskId);
    if (!task?.decomposition || task.decomposition.id !== proposalId) return null;
    task.decomposition.status = 'applied';
    task.decomposition.appliedChildTaskIds = applied.children.map((child) => child.id);
    task.updatedAt = nowIso();
    board.updatedAt = task.updatedAt;
    return { task, proposal: task.decomposition };
  });
  if (!stamped?.result) return null;

  await emitKanbanEvent(
    projectRoot,
    createKanbanEvent(stamped.board.id, stamped.result.task, 'task.decomposition.applied', {
      ...eventContext,
      after: {
        proposalId,
        children: applied.children.map((child) => child.id),
        source: 'proactive',
      },
    }),
  );
  return { board: stamped.board, task: stamped.result.task, proposal: stamped.result.proposal };
}
