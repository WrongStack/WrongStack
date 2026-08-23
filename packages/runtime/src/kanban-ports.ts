/**
 * kanban-ports — one-shot composition wiring for core's kanban ports.
 *
 * Core resolves all kanban operations through four ports (Roadmap #11):
 * governance (per-tool-call boundary checks), boundary ops, board store
 * (goal sync), and dispatch (director queue). Hosts that construct a
 * `ToolExecutor` or register coordination tools MUST wire these before
 * serving requests, or the ports throw "not wired" on first use.
 *
 * This module is idempotent: calling it from several boot paths (CLI,
 * MCP serve, ACP agent, WebUI server) is safe and cheap.
 */
import { setKanbanBoundaryOps, setKanbanDispatch } from '@wrongstack/core/coordination';
import { setKanbanGovernance } from '@wrongstack/core/security';
import { setBoardStorePort } from '@wrongstack/core/storage';
import {
  addTask,
  completeKanbanDispatch,
  createBoard,
  describeKanbanBoundary,
  evaluateContractGraphReadiness,
  evaluateKanbanBoundaryOpaque,
  evaluateKanbanBoundaryPath,
  failKanbanDispatch,
  getBoard,
  heartbeatTaskAssignment,
  listBoards,
  listReadyTasks,
  readBoard,
  removeBoard,
  reserveKanbanDispatch,
  resolveKanbanBoundaryLayers,
  startKanbanDispatch,
  updateTask,
  updateTaskAssignment,
} from '@wrongstack/kanban';

let wired = false;

/** Wire core's kanban ports to the real kanban-backed implementation. */
export function wireKanbanPorts(): void {
  if (wired) return;
  wired = true;
  setKanbanBoundaryOps({ describeKanbanBoundary });
  setKanbanGovernance({
    readBoard,
    resolveKanbanBoundaryLayers,
    evaluateKanbanBoundaryOpaque,
    evaluateKanbanBoundaryPath,
    evaluateContractGraphReadiness,
  });
  setBoardStorePort({
    createBoard,
    listBoards,
    getBoard,
    removeBoard,
    addTask,
    updateTask,
  });
  setKanbanDispatch({
    getBoard,
    listReadyTasks,
    reserveKanbanDispatch,
    startKanbanDispatch,
    completeKanbanDispatch,
    failKanbanDispatch,
    updateTaskAssignment,
    heartbeatTaskAssignment,
  });
}
