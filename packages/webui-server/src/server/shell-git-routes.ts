import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';

export interface ShellGitRouteHandlers {
  gitInfo: (ws: WebSocket) => Promise<void>;
  gitChanges: (ws: WebSocket) => Promise<void>;
  gitDiff: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  gitStage?: ((ws: WebSocket, msg: WSClientMessage) => Promise<void>) | undefined;
  gitUnstage?: ((ws: WebSocket, msg: WSClientMessage) => Promise<void>) | undefined;
  gitDiscard?: ((ws: WebSocket, msg: WSClientMessage) => Promise<void>) | undefined;
  gitCommit?: ((ws: WebSocket, msg: WSClientMessage) => Promise<void>) | undefined;
  shellOpen: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
}

export async function handleShellGitRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: ShellGitRouteHandlers,
): Promise<boolean> {
  switch (msg.type) {
    case 'git.info':
      await handlers.gitInfo(ws);
      return true;
    case 'git.changes':
      await handlers.gitChanges(ws);
      return true;
    case 'git.diff':
      await handlers.gitDiff(ws, msg);
      return true;
    case 'git.stage':
      if (handlers.gitStage) await handlers.gitStage(ws, msg);
      return true;
    case 'git.unstage':
      if (handlers.gitUnstage) await handlers.gitUnstage(ws, msg);
      return true;
    case 'git.discard':
      if (handlers.gitDiscard) await handlers.gitDiscard(ws, msg);
      return true;
    case 'git.commit':
      if (handlers.gitCommit) await handlers.gitCommit(ws, msg);
      return true;
    case 'shell.open':
      await handlers.shellOpen(ws, msg);
      return true;
    default:
      return false;
  }
}
