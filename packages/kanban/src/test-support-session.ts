/**
 * Session-bound Kanban domain surface for tests.
 *
 * Every mutating domain call names the session that owns the durable event it
 * writes. Most tests care about the mutation, not the attribution, so this
 * module re-exports the domain with one fixed test session already bound:
 * import from `@wrongstack/kanban/test-support` instead of
 * `@wrongstack/kanban` and the call sites stay as they were. Pass an explicit
 * context in the usual trailing position when a test is specifically about
 * attribution — an explicitly supplied one always wins.
 *
 * Test-only: reachable through the `./test-support` subpath, which refuses to
 * load outside a test run.
 */

import * as domain from './index.js';
import type { KanbanEventContext } from './types.js';

// The package index, not manager.js: index.ts deliberately overrides some of
// manager's stateful names for package consumers, and tests should see the
// same surface the rest of the repo does.
export * from './index.js';

/** The session every un-annotated test mutation is attributed to. */
export const TEST_EVENT_CONTEXT: KanbanEventContext = {
  sessionId: '2026-08-26/sess_01TESTKANBAN0000000000000',
};

type AnyFn = (...args: never[]) => unknown;

/** Fill the trailing event-context argument when the caller omitted it. */
function bindTrailing<F extends AnyFn>(fn: F, arity: number): F {
  return ((...args: unknown[]) => {
    if (args.length >= arity) return (fn as unknown as (...a: unknown[]) => unknown)(...args);
    const padded = [...args];
    while (padded.length < arity - 1) padded.push(undefined);
    padded.push(TEST_EVENT_CONTEXT);
    return (fn as unknown as (...a: unknown[]) => unknown)(...padded);
  }) as unknown as F;
}

/** Fill `options.eventContext` when the caller left it out. */
function bindOptions<F extends AnyFn>(fn: F, optionsIndex: number): F {
  return ((...args: unknown[]) => {
    const padded = [...args];
    while (padded.length <= optionsIndex) padded.push(undefined);
    const options = (padded[optionsIndex] ?? {}) as Record<string, unknown>;
    padded[optionsIndex] = { eventContext: TEST_EVENT_CONTEXT, ...options };
    return (fn as unknown as (...a: unknown[]) => unknown)(...padded);
  }) as unknown as F;
}

export const addCheckToTask = bindTrailing(domain.addCheckToTask, 5);
export const addContractEdge = bindTrailing(domain.addContractEdge, 4);
export const addDependency = bindTrailing(domain.addDependency, 5);
export const addGoalMetricToTask = bindTrailing(domain.addGoalMetricToTask, 5);
export const addLinkToTask = bindTrailing(domain.addLinkToTask, 5);
export const addNoteToTask = bindTrailing(domain.addNoteToTask, 5);
export const addTask = bindTrailing(domain.addTask, 4);
export const assignTask = bindTrailing(domain.assignTask, 5);
export const claimReadyTask = bindTrailing(domain.claimReadyTask, 3);
export const configureContractGraph = bindTrailing(domain.configureContractGraph, 4);
export const heartbeatTaskAssignment = bindTrailing(domain.heartbeatTaskAssignment, 5);
export const mergeTasks = bindTrailing(domain.mergeTasks, 4);
export const moveTask = bindTrailing(domain.moveTask, 6);
export const proposeTaskDecomposition = bindTrailing(domain.proposeTaskDecomposition, 5);
export const reconcileKanbanBoard = bindTrailing(domain.reconcileKanbanBoard, 3);
export const recordTaskActivity = bindTrailing(domain.recordTaskActivity, 5);
export const recoverStaleTaskAssignments = bindTrailing(domain.recoverStaleTaskAssignments, 4);
export const releaseTaskClaim = bindTrailing(domain.releaseTaskClaim, 5);
export const removeCheckFromTask = bindTrailing(domain.removeCheckFromTask, 5);
export const removeContractEdge = bindTrailing(domain.removeContractEdge, 4);
export const removeContractNode = bindTrailing(domain.removeContractNode, 4);
export const removeTask = bindTrailing(domain.removeTask, 4);
export const resolveDecompositionProposal = bindTrailing(domain.resolveDecompositionProposal, 6);
export const setTaskChain = bindTrailing(domain.setTaskChain, 4);
export const splitTask = bindTrailing(domain.splitTask, 5);
export const updateCheckOnTask = bindTrailing(domain.updateCheckOnTask, 6);
export const updateGoalMetricOnTask = bindTrailing(domain.updateGoalMetricOnTask, 6);
export const updateTask = bindTrailing(domain.updateTask, 5);
export const updateTaskAssignment = bindTrailing(domain.updateTaskAssignment, 5);
export const upsertContractNode = bindTrailing(domain.upsertContractNode, 4);
export const assessTaskAtomicity = bindOptions(domain.assessTaskAtomicity, 3);
export const copyTaskToBoard = bindOptions(domain.copyTaskToBoard, 4);
export const enforceCompletionGate = bindOptions(domain.enforceCompletionGate, 3);
export const finalizeTaskCompletion = bindOptions(domain.finalizeTaskCompletion, 3);
export const transferTaskToBoard = bindOptions(domain.transferTaskToBoard, 4);
export const verifyTaskCompletion = bindOptions(domain.verifyTaskCompletion, 3);

/** Fill `input.sessionId` on an input-object call when the caller omitted it. */
function bindInputSession<F extends AnyFn>(fn: F, inputIndex: number): F {
  return ((...args: unknown[]) => {
    const padded = [...args];
    while (padded.length <= inputIndex) padded.push(undefined);
    const input = (padded[inputIndex] ?? {}) as Record<string, unknown>;
    padded[inputIndex] = { sessionId: TEST_EVENT_CONTEXT.sessionId, ...input };
    return (fn as unknown as (...a: unknown[]) => unknown)(...padded);
  }) as unknown as F;
}

export const transitionTask = bindInputSession(domain.transitionTask, 3);
export const transitionManagedTask = transitionTask;
export const recordCompletionRefusal = bindOptions(domain.recordCompletionRefusal, 3);
export const reserveKanbanDispatch = bindInputSession(domain.reserveKanbanDispatch, 1);
export const startKanbanDispatch = bindInputSession(domain.startKanbanDispatch, 1);
export const completeKanbanDispatch = bindInputSession(domain.completeKanbanDispatch, 1);
export const failKanbanDispatch = bindInputSession(domain.failKanbanDispatch, 1);
export const cancelKanbanDispatch = bindInputSession(domain.cancelKanbanDispatch, 1);
export const heartbeatKanbanDispatch = bindInputSession(domain.heartbeatKanbanDispatch, 1);
