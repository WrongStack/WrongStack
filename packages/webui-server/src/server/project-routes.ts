import type { WebSocket } from 'ws';
import { correlatedReply } from './correlated-reply.js';
import type { WSClientMessage } from './types.js';

export interface ProjectRouteHandlers {
  listProjects: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  addProject: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  selectProject: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  setWorkingDir: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
}

export async function handleProjectRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: ProjectRouteHandlers,
): Promise<boolean> {
  switch (msg.type) {
    case 'projects.list':
      await handlers.listProjects(correlatedReply(ws, msg.payload, ['projects.list']).socket, msg);
      return true;
    case 'projects.add':
      await handlers.addProject(ws, msg);
      return true;
    case 'projects.select':
      await handlers.selectProject(ws, msg);
      return true;
    case 'working_dir.set':
      await handlers.setWorkingDir(ws, msg);
      return true;
    default:
      return false;
  }
}
