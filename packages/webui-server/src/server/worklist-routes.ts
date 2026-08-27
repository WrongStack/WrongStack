import type { WebSocket } from 'ws';
import {
  handleWorklistMessage,
  type WorklistContext,
  type WorklistMessage,
} from './handlers/worklist-handlers.js';
import type { WSClientMessage } from './types.js';

export interface WorklistRouteHandlers {
  getTodos: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  clearTodos: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  removeTodo: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  updateTodo: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  getTasks: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  updateTask: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  getPlan: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  usePlanTemplate: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
  updatePlanItem: (ws: WebSocket, msg: WSClientMessage) => Promise<void> | void;
}

export interface WorklistRouteContext {
  /**
   * Resolve the worklist context for ONE request. The message is handed over
   * so a multi-session host can bind to the session the payload names instead
   * of whichever session the shared root context currently points at.
   * Hosts that ignore it keep the single-context behaviour.
   */
  getContext: (message?: WorklistMessage) => WorklistContext;
  allowMessage?: ((ws: WebSocket, message: WSClientMessage) => boolean) | undefined;
}

export function createWorklistRouteHandlers(ctx: WorklistRouteContext): WorklistRouteHandlers {
  const dispatch = async (ws: WebSocket, message: WSClientMessage): Promise<void> => {
    if (ctx.allowMessage && !ctx.allowMessage(ws, message)) return;
    await handleWorklistMessage(ctx.getContext(message as WorklistMessage), ws, message);
  };
  return {
    getTodos: dispatch,
    clearTodos: dispatch,
    removeTodo: dispatch,
    updateTodo: dispatch,
    getTasks: dispatch,
    updateTask: dispatch,
    getPlan: dispatch,
    usePlanTemplate: dispatch,
    updatePlanItem: dispatch,
  };
}

export async function handleWorklistRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: WorklistRouteHandlers,
): Promise<boolean> {
  switch (msg.type) {
    case 'todos.get':
      await handlers.getTodos(ws, msg);
      return true;
    case 'todos.clear':
      await handlers.clearTodos(ws, msg);
      return true;
    case 'todos.remove':
      await handlers.removeTodo(ws, msg);
      return true;
    case 'todo.update':
      await handlers.updateTodo(ws, msg);
      return true;
    case 'tasks.get':
      await handlers.getTasks(ws, msg);
      return true;
    case 'task.update':
      await handlers.updateTask(ws, msg);
      return true;
    case 'plan.get':
      await handlers.getPlan(ws, msg);
      return true;
    case 'plan.template_use':
      await handlers.usePlanTemplate(ws, msg);
      return true;
    case 'plan.item.update':
      await handlers.updatePlanItem(ws, msg);
      return true;
    default:
      return false;
  }
}
