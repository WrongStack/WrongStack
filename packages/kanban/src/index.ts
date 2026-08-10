export * from './boundary.js';
// Explicit exports override the stateful names from manager.js for package
// consumers. The project server imports manager.js directly and is therefore
// the only production process that executes domain mutations locally.
export {
  addCheckToTask,
  addColumn,
  addContractEdge,
  addDependency,
  addGoalMetricToTask,
  addLinkToTask,
  addNoteToTask,
  addTask,
  adoptManagedLifecycle,
  assessTaskAtomicity,
  assignTask,
  attachVerificationReport,
  cancelKanbanDispatch,
  claimReadyTask,
  completeKanbanDispatch,
  configureContractGraph,
  copyTaskToBoard,
  createBoard,
  createBoardFromTaskGraph,
  createBoardsFromPhaseGraph,
  duplicateBoard,
  enforceCompletionGate,
  evaluateTaskContractGraph,
  exportBoardMarkdown,
  exportBoardToTaskGraph,
  failKanbanDispatch,
  finalizeTaskCompletion,
  getBoard,
  getBoardWithLivePresence,
  getContractGraph,
  getKanbanOrchestrationSnapshot,
  getKanbanQueueHealth,
  getKanbanWorkbench,
  getTask,
  getTaskChain,
  heartbeatKanbanDispatch,
  heartbeatTaskAssignment,
  listBoards,
  listKanbanEvents,
  listReadyTasks,
  listTaskActivity,
  mergeTasks,
  moveTask,
  proposeTaskDecomposition,
  pruneSessionBoards,
  reconcileKanbanBoard,
  recordTaskActivity,
  recordTaskFileActivity,
  recoverStaleTaskAssignments,
  releaseTaskClaim,
  removeBoard,
  removeColumn,
  removeContractEdge,
  removeContractNode,
  removeTask,
  repairManagedTaskProjection,
  reserveKanbanDispatch,
  resolveDecompositionProposal,
  searchKanban,
  setTaskChain,
  splitTask,
  startKanbanDispatch,
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
  upsertContractNode,
  verifyTaskCompletion,
} from './client-domain.js';
export {
  createEmptyContractGraph,
  evaluateContractGraph,
  evaluateContractGraphReadiness,
  taskContractEndpoint,
} from './contract-graph.js';
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
export * from './types.js';
// Exported so `packages/tools/tests/regex-guard-parity.test.ts` can hold this
// copy to the same verdicts as the canonical guard in `tools/src/_regex.ts`.
// Kanban sits below tools in the layer DAG and cannot import it directly.
export {
  capSubject as capRegexSubject,
  compileSafeRegex,
  MAX_SUBJECT_LEN,
  type SafeRegexResult,
} from './verification/safe-regex.js';
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
