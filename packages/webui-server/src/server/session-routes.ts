import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';

export interface SessionRouteHandlers {
  newSession: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  clearContext: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  debugContext: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  compactContext: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  repairContext: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  openContextEditor: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  validateContextEditor: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  applyContextEditor: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  listContextModes: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  switchContextMode: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  createContextMode: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  updateContextMode: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  deleteContextMode: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  listSessions: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  renameSession: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  deleteSession: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  resumeSession: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  saveSession: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  inspectSession: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  listCheckpoints: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  rewindSession: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  /** Declare which sessions this connection is displaying (its open tabs). */
  subscribeSessions: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
}

export async function handleSessionRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: SessionRouteHandlers,
): Promise<boolean> {
  switch (msg.type) {
    case 'session.new':
      await handlers.newSession(ws, msg);
      return true;
    case 'context.clear':
      await handlers.clearContext(ws, msg);
      return true;
    case 'context.debug':
      await handlers.debugContext(ws, msg);
      return true;
    case 'context.compact':
      await handlers.compactContext(ws, msg);
      return true;
    case 'context.repair':
      await handlers.repairContext(ws, msg);
      return true;
    case 'context.editor.open':
      await handlers.openContextEditor(ws, msg);
      return true;
    case 'context.editor.validate':
      await handlers.validateContextEditor(ws, msg);
      return true;
    case 'context.editor.apply':
      await handlers.applyContextEditor(ws, msg);
      return true;
    case 'context.modes.list':
      await handlers.listContextModes(ws, msg);
      return true;
    case 'context.mode.switch':
      await handlers.switchContextMode(ws, msg);
      return true;
    case 'context.mode.create':
      await handlers.createContextMode(ws, msg);
      return true;
    case 'context.mode.update':
      await handlers.updateContextMode(ws, msg);
      return true;
    case 'context.mode.delete':
      await handlers.deleteContextMode(ws, msg);
      return true;
    case 'sessions.list':
      await handlers.listSessions(ws, msg);
      return true;
    case 'session.rename':
      await handlers.renameSession(ws, msg);
      return true;
    case 'session.delete':
      await handlers.deleteSession(ws, msg);
      return true;
    case 'session.resume':
      await handlers.resumeSession(ws, msg);
      return true;
    case 'session.save':
      await handlers.saveSession(ws, msg);
      return true;
    case 'session.inspect':
      await handlers.inspectSession(ws, msg);
      return true;
    case 'session.checkpoints':
      await handlers.listCheckpoints(ws, msg);
      return true;
    case 'session.rewind':
      await handlers.rewindSession(ws, msg);
      return true;
    case 'session.subscribe':
      await handlers.subscribeSessions(ws, msg);
      return true;
    default:
      return false;
  }
}
