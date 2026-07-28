/**
 * Kanban Project Server — wire protocol
 *
 * Line-delimited JSON frames over a persistent net.Socket connection
 * (named pipe on Windows, Unix domain socket on other platforms).
 *
 * Framing:
 *   Client → Server  { id, method, params }
 *   Server → Client  { id, ok?, error?, result? }
 *   Server → Client  { type: 'event', event, data }
 *   Server → Client  { type: 'hello', ...info }
 *
 * Server → Client (errors):
 *   { id, error: { code, message } }
 *   code values: NOT_FOUND | READ_FAILED | WRITE_FAILED | INVALID_INPUT | INTERNAL_ERROR
 */

export const KANBAN_PROJECT_SERVER_PROTOCOL_VERSION = 1;

// ─── Server metadata ─────────────────────────────────────────────────────────

export interface KanbanProjectServerInfo {
  protocolVersion: number;
  pid: number;
  projectRoot: string;
  endpoint: string;
  startedAt: string;
}

export interface KanbanProjectServerStatus extends KanbanProjectServerInfo {
  clients: number;
  pendingRequests: number;
}

// ─── Operations exposed by the server ──────────────────────────────────────

export interface KanbanServerOperations {
  // Info / control
  ping: { args: Record<string, never>; result: KanbanProjectServerStatus };
  shutdown: { args: { reason?: string }; result: { stopping: boolean } };

  // Board reads
  listBoards: { args: Record<string, never>; result: string /* KanbanBoard[] json */ };
  getBoard: { args: { boardId: string }; result: string /* KanbanBoard */ };
  getKanbanOrchestrationSnapshot: {
    args: { query?: string; assignee?: string };
    result: string /* KanbanOrchestrationSnapshot json */
  };
  searchTasks: { args: { query?: string; boardId?: string }; result: string };
  readyTasks: { args: { query?: string; boardId?: string }; result: string };
  getTask: { args: { boardId: string; taskId: string }; result: string };
  getChain: { args: { boardId: string; taskId?: string; chainId?: string }; result: string };
  listBoardSummaries: { args: Record<string, never>; result: string };

  // Board mutations
  createBoard: { args: { title: string; description?: string; taskType?: string }; result: string };
  updateBoard: { args: { boardId: string; title?: string; description?: string }; result: string };
  duplicateBoard: { args: { boardId: string; newTitle?: string }; result: string };
  deleteBoard: { args: { boardId: string }; result: boolean };
  generateBoard: { args: { description: string }; result: string };

  // Column mutations
  addColumn: { args: { boardId: string; title: string; order?: number }; result: string };
  updateColumn: { args: { boardId: string; columnId: string; title?: string; order?: number }; result: string };
  deleteColumn: { args: { boardId: string; columnId: string }; result: string };

  // Task mutations
  addTask: { args: { boardId: string; title: string; taskType?: string; priority?: string; description?: string; tags?: string[]; labels?: string[]; dueDate?: string; estimateHours?: number }; result: string };
  updateTask: { args: { boardId: string; taskId: string; [key: string]: unknown }; result: string };
  deleteTask: { args: { boardId: string; taskId: string }; result: string };
  moveTask: { args: { boardId: string; taskId: string; targetColumnId: string; order?: number }; result: string };
  splitTask: { args: { boardId: string; taskId: string; childTitles: string[] }; result: string };
  mergeTasks: { args: { boardId: string; taskIds: string[]; title: string }; result: string };
  copyTask: { args: { boardId: string; taskId: string; targetBoardId: string }; result: string };
  transferTask: { args: { boardId: string; taskId: string; targetBoardId: string; targetColumnId?: string }; result: string };

  // Lifecycle / orchestration
  transitionTask: {
    args: {
      boardId: string;
      taskId: string;
      to?: string;
      status?: string;
      [key: string]: unknown;
    };
    result: unknown;
  };
  claimTask: { args: { boardId?: string; agentId?: string; role?: string; priority?: string }; result: string };
  releaseTask: { args: { boardId: string; taskId: string }; result: string };
  assignTask: {
    args: {
      boardId: string;
      taskId: string;
      input: Record<string, unknown>;
      eventContext?: Record<string, unknown>;
    };
    result: unknown;
  };
  updateTaskAssignment: {
    args: {
      boardId: string;
      taskId: string;
      patch: Record<string, unknown>;
      eventContext?: Record<string, unknown>;
    };
    result: unknown;
  };
  finalizeTaskCompletion: {
    args: {
      boardId: string;
      taskId: string;
      options?: Record<string, unknown>;
    };
    result: unknown;
  };
  heartbeatAssignment: { args: { boardId: string; taskId: string; currentTask?: string }; result: string };
  verifyTaskCompletion: {
    args: { boardId: string; taskId: string; persist?: boolean };
    result: unknown;
  };
  /** @deprecated Use verifyTaskCompletion. Kept for older clients. */
  verifyCompletion: {
    args: { boardId: string; taskId: string; persist?: boolean };
    result: unknown;
  };
  recoverStaleTaskAssignments: { args: { boardId?: string }; result: string };

  adoptManagedLifecycle: {
    args: { boardId: string; taskId: string; author: string; transitionComment: string };
    result: string;
  };
  repairManagedProjection: {
    args: { boardId: string; taskId: string; author: string; transitionComment: string };
    result: string;
  };
  reconcileBoard: { args: { boardId: string }; result: unknown };

  // Chains
  setChain: {
    args: {
      boardId: string;
      taskIds: string[];
      chainId?: string;
      enforceDependencies?: boolean;
    };
    result: unknown;
  };

  // Task graph
  syncTaskGraph: { args: { boardId: string; taskGraph: string }; result: string };
  createFromGraph: { args: { taskGraph: string; boardId?: string; boardTitle?: string }; result: string };
  importSessionTasks: { args: { boardId?: string; boardTitle?: string }; result: string };

  // Export
  exportMarkdown: { args: { boardId: string }; result: string };
  exportTaskGraph: { args: { boardId: string }; result: string };

  // Verification helpers
  assessAtomicity: { args: { boardId: string; taskId: string }; result: unknown };
}

export type KanbanServerMethod = keyof KanbanServerOperations;

// ─── Wire frames ────────────────────────────────────────────────────────────

export interface KanbanRequest<M extends KanbanServerMethod = KanbanServerMethod> {
  id: number;
  method: M;
  params: KanbanServerOperations[M]['args'];
}

export interface KanbanSuccessResponse {
  id: number;
  ok: true;
  result: unknown;
}

export interface KanbanErrorResponse {
  id: number;
  error: {
    code: KanbanErrorCode;
    message: string;
    cause?: unknown;
  };
}

export type KanbanResponse = KanbanSuccessResponse | KanbanErrorResponse;

export type KanbanErrorCode =
  | 'NOT_FOUND'
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'INVALID_INPUT'
  | 'ALREADY_EXISTS'
  | 'INTERNAL_ERROR';

export interface KanbanServerEvent {
  type: 'event';
  event: KanbanEventName;
  data: unknown;
}

export type KanbanEventName =
  | 'board.created'
  | 'board.updated'
  | 'board.deleted'
  | 'task.added'
  | 'task.updated'
  | 'task.deleted'
  | 'task.moved'
  | 'task.transitioned'
  | 'column.added'
  | 'column.updated'
  | 'column.deleted';

export interface KanbanHelloFrame extends KanbanProjectServerInfo {
  type: 'hello';
}
