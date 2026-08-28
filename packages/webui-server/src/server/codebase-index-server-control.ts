import type { TrustBoundary } from '@wrongstack/core/security';
import type { Logger } from '@wrongstack/core/types';
import { shutdownCodebaseIndexServer } from '@wrongstack/tools';
import type { WebSocket } from 'ws';
import { authorizeWebUIAction } from './privileged-actions.js';
import type { WSClientMessage, WSServerMessage } from './types.js';

interface CodebaseIndexServerControlDeps {
  trustBoundary: TrustBoundary;
  logger?: Logger | undefined;
  getProjectRoot(): string;
  getIndexDir(): string | undefined;
  send(ws: WebSocket, message: WSServerMessage): void;
  backend: 'standalone' | 'cli-embedded';
}

/** Handle the WebSocket control message that stops this project's index server. */
export async function handleCodebaseIndexServerControl(
  ws: WebSocket,
  message: WSClientMessage,
  deps: CodebaseIndexServerControlDeps,
): Promise<boolean> {
  if (message.type !== 'codebase.index.server.shutdown') return false;

  const requestId =
    message.payload &&
    typeof message.payload === 'object' &&
    typeof (message.payload as { requestId?: unknown }).requestId === 'string'
      ? (message.payload as { requestId: string }).requestId
      : '';
  const projectRoot = deps.getProjectRoot();
  const authorization = await authorizeWebUIAction(
    deps.trustBoundary,
    {
      capability: 'codebase-index.server.shutdown',
      subject: { kind: 'process', id: projectRoot },
      risk: 'elevated',
      cwd: projectRoot,
      metadata: { transport: 'websocket', backend: deps.backend },
    },
    deps.logger,
  );
  if (!authorization.allowed) {
    deps.send(ws, {
      type: 'codebase.index.server.shutdown_result',
      payload: {
        requestId,
        stopped: false,
        reason: `Shutdown denied: ${authorization.reason}`,
      },
    });
    return true;
  }

  const result = await shutdownCodebaseIndexServer(
    projectRoot,
    deps.getIndexDir(),
    'websocket-request',
  );
  deps.send(ws, {
    type: 'codebase.index.server.shutdown_result',
    payload: { requestId, ...result },
  });
  return true;
}
