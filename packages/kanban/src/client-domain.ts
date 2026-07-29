import { KANBAN_DOMAIN_OPERATIONS, type KanbanDomainOperation } from './domain-operations.js';
import type * as DomainApi from './manager.js';
import { getKanbanServerConnection } from './server/client.js';
import { decodeKanbanDomainValue, encodeKanbanDomainValue } from './server/protocol.js';

type DomainModule = typeof DomainApi;
type DomainFunction<K extends KanbanDomainOperation> = DomainModule[K];

const operationSet = new Set<string>(KANBAN_DOMAIN_OPERATIONS);

function bindDomainOperation<K extends KanbanDomainOperation>(operation: K): DomainFunction<K> {
  if (!operationSet.has(operation)) {
    throw new Error(`Unregistered Kanban domain operation: ${operation}`);
  }
  return (async (projectRoot: string, ...args: unknown[]) => {
    // Existing unit tests exercise domain algorithms and the legacy migration
    // codec in-process. Production and IPC integration tests never enter this
    // branch.
    if (
      process.env['NODE_ENV'] === 'test' &&
      process.env['VITEST'] === 'true' &&
      process.env['WRONGSTACK_KANBAN_FORCE_IPC'] !== '1'
    ) {
      const local = (await import('./manager.js')) as unknown as Record<
        string,
        (...callArgs: unknown[]) => unknown
      >;
      return local[operation]?.(projectRoot, ...args);
    }

    const connection = await getKanbanServerConnection(projectRoot);
    if (!connection) {
      throw new Error('Kanban project server is disabled; stateful clients require IPC');
    }
    while (args.length > 0 && args.at(-1) === undefined) args.pop();
    const result = await connection.request('domainCall', {
      operation,
      wireArgs: encodeKanbanDomainValue(args),
    });
    return decodeKanbanDomainValue(result);
  }) as DomainFunction<K>;
}

export const createBoard = bindDomainOperation('createBoard');
export const listBoards = bindDomainOperation('listBoards');
export const getBoard = bindDomainOperation('getBoard');
export const updateBoard = bindDomainOperation('updateBoard');
export const removeBoard = bindDomainOperation('removeBoard');
export const duplicateBoard = bindDomainOperation('duplicateBoard');
export const addColumn = bindDomainOperation('addColumn');
export const updateColumn = bindDomainOperation('updateColumn');
export const removeColumn = bindDomainOperation('removeColumn');
export const addTask = bindDomainOperation('addTask');
export const copyTaskToBoard = bindDomainOperation('copyTaskToBoard');
export const transferTaskToBoard = bindDomainOperation('transferTaskToBoard');
export const updateTask = bindDomainOperation('updateTask');
export const moveTask = bindDomainOperation('moveTask');
export const removeTask = bindDomainOperation('removeTask');
export const getTask = bindDomainOperation('getTask');
export const listKanbanEvents = bindDomainOperation('listKanbanEvents');
export const listTaskActivity = bindDomainOperation('listTaskActivity');
export const recordTaskActivity = bindDomainOperation('recordTaskActivity');
export const recordTaskFileActivity = bindDomainOperation('recordTaskFileActivity');
export const addGoalMetricToTask = bindDomainOperation('addGoalMetricToTask');
export const updateGoalMetricOnTask = bindDomainOperation('updateGoalMetricOnTask');
export const addCheckToTask = bindDomainOperation('addCheckToTask');
export const updateCheckOnTask = bindDomainOperation('updateCheckOnTask');
export const addNoteToTask = bindDomainOperation('addNoteToTask');
export const addLinkToTask = bindDomainOperation('addLinkToTask');
export const reconcileKanbanBoard = bindDomainOperation('reconcileKanbanBoard');
export const assignTask = bindDomainOperation('assignTask');
export const updateTaskAssignment = bindDomainOperation('updateTaskAssignment');
export const heartbeatTaskAssignment = bindDomainOperation('heartbeatTaskAssignment');
export const recoverStaleTaskAssignments = bindDomainOperation('recoverStaleTaskAssignments');
export const claimReadyTask = bindDomainOperation('claimReadyTask');
export const releaseTaskClaim = bindDomainOperation('releaseTaskClaim');
export const getKanbanOrchestrationSnapshot = bindDomainOperation('getKanbanOrchestrationSnapshot');
export const getKanbanQueueHealth = bindDomainOperation('getKanbanQueueHealth');
export const addDependency = bindDomainOperation('addDependency');
export const splitTask = bindDomainOperation('splitTask');
export const mergeTasks = bindDomainOperation('mergeTasks');
export const setTaskChain = bindDomainOperation('setTaskChain');
export const getTaskChain = bindDomainOperation('getTaskChain');
export const listReadyTasks = bindDomainOperation('listReadyTasks');
export const createBoardFromTaskGraph = bindDomainOperation('createBoardFromTaskGraph');
export const syncBoardFromTaskGraph = bindDomainOperation('syncBoardFromTaskGraph');
export const exportBoardToTaskGraph = bindDomainOperation('exportBoardToTaskGraph');
export const createBoardsFromPhaseGraph = bindDomainOperation('createBoardsFromPhaseGraph');
export const searchKanban = bindDomainOperation('searchKanban');
export const exportBoardMarkdown = bindDomainOperation('exportBoardMarkdown');
export const adoptManagedLifecycle = bindDomainOperation('adoptManagedLifecycle');
export const repairManagedTaskProjection = bindDomainOperation('repairManagedTaskProjection');
export const transitionTask = bindDomainOperation('transitionTask');
export const touchKanbanPresence = bindDomainOperation('touchKanbanPresence');
export const getBoardWithLivePresence = bindDomainOperation('getBoardWithLivePresence');
export const assessTaskAtomicity = bindDomainOperation('assessTaskAtomicity');
export const proposeTaskDecomposition = bindDomainOperation('proposeTaskDecomposition');
export const resolveDecompositionProposal = bindDomainOperation('resolveDecompositionProposal');
export const verifyTaskCompletion = bindDomainOperation('verifyTaskCompletion');
export const enforceCompletionGate = bindDomainOperation('enforceCompletionGate');
export const attachVerificationReport = bindDomainOperation('attachVerificationReport');
export const finalizeTaskCompletion = bindDomainOperation('finalizeTaskCompletion');
