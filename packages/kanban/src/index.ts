export * from './boundary.js';
// Explicit exports override the stateful names from manager.js for package
// consumers. The project server imports manager.js directly and is therefore
// the only production process that executes domain mutations locally.
export {
  addCheckToTask,
  addColumn,
  addDependency,
  addGoalMetricToTask,
  addLinkToTask,
  addNoteToTask,
  addTask,
  adoptManagedLifecycle,
  assessTaskAtomicity,
  assignTask,
  attachVerificationReport,
  claimReadyTask,
  copyTaskToBoard,
  createBoard,
  createBoardFromTaskGraph,
  createBoardsFromPhaseGraph,
  duplicateBoard,
  enforceCompletionGate,
  exportBoardMarkdown,
  exportBoardToTaskGraph,
  finalizeTaskCompletion,
  getBoard,
  getBoardWithLivePresence,
  getKanbanOrchestrationSnapshot,
  getKanbanQueueHealth,
  getTask,
  getTaskChain,
  heartbeatTaskAssignment,
  listBoards,
  listKanbanEvents,
  listReadyTasks,
  listTaskActivity,
  mergeTasks,
  moveTask,
  proposeTaskDecomposition,
  reconcileKanbanBoard,
  recordTaskActivity,
  recordTaskFileActivity,
  recoverStaleTaskAssignments,
  releaseTaskClaim,
  removeBoard,
  removeColumn,
  removeTask,
  repairManagedTaskProjection,
  resolveDecompositionProposal,
  searchKanban,
  setTaskChain,
  splitTask,
  syncBoardFromTaskGraph,
  touchKanbanPresence,
  transferTaskToBoard,
  transitionTask,
  updateBoard,
  updateCheckOnTask,
  updateColumn,
  updateGoalMetricOnTask,
  updateTask,
  updateTaskAssignment,
  verifyTaskCompletion,
  reserveKanbanDispatch,
  startKanbanDispatch,
  completeKanbanDispatch,
  failKanbanDispatch,
  cancelKanbanDispatch,
  heartbeatKanbanDispatch,
  pruneSessionBoards,
} from './client-domain.js';
export * from './manager.js';
export {
  closeKanbanServerConnections,
  getKanbanServerConnection,
  isKanbanServerAvailable,
  KANBAN_PROJECT_SERVER_PROTOCOL_VERSION,
} from './server/client.js';
export { kanbanProjectServerEndpoint } from './server/endpoint.js';
export * from './server/kanban-store.js';
export {
  type BridgeOptions,
  bridgeKanbanSupervisor,
  type KanbanSupervisorEvent,
} from './server/kanban-supervisor-bridge.js';
export type {
  KanbanErrorCode,
  KanbanHelloFrame,
  KanbanProjectServerInfo,
  KanbanProjectServerStatus,
  KanbanRequest,
  KanbanResponse,
  KanbanServerEvent,
  KanbanServerMethod,
  KanbanServerOperations,
  KanbanWorkflowCommand,
  KanbanWorkflowState,
} from './server/protocol.js';
export {
  appendKanbanEvent,
  deleteBoard,
  listBoardIds,
  readBoard,
  readKanbanEvents,
  readKanbanMetadata,
  writeBoard,
  writeKanbanMetadata,
} from './storage.js';
// Exported so `packages/tools/tests/regex-guard-parity.test.ts` can hold this
// copy to the same verdicts as the canonical guard in `tools/src/_regex.ts`.
// Kanban sits below tools in the layer DAG and cannot import it directly.
export {
  capSubject as capRegexSubject,
  compileSafeRegex,
  MAX_SUBJECT_LEN,
  type SafeRegexResult,
} from './verification/safe-regex.js';
export * from './types.js';
export {
  drainKanbanWorkflowCommands,
  type EnqueueKanbanWorkflowCommandInput,
  enqueueKanbanWorkflowCommand,
  kanbanWorkflowId,
  subscribeKanbanWorkflowCommands,
} from './workflow-commands.js';
export {
  deleteKanbanWorkflowState,
  listKanbanWorkflowStates,
  readKanbanWorkflowState,
  writeKanbanWorkflowState,
} from './workflow-state.js';
