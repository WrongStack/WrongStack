import type { MemoryPort } from '@wrongstack/core/types';
import type { WebSocket } from 'ws';
import {
  handleMemoryList,
  handleSageBackfillRecoverable,
  handleSageCandidateResolve,
  handleSageDelete,
  handleSageForFile,
  handleSageGet,
  handleSageGraph,
  handleSageList,
  handleSageListCandidates,
  handleSageListPage,
  handleSageRecover,
  handleSageRemember,
  handleSageSearchBreakdown,
  handleSageUpdate,
} from './memory-handlers.js';
import type { WSClientMessage, WSServerMessage } from './types.js';

export interface MemoryRouteContext {
  getMemoryStore: () => MemoryPort | undefined;
  send: (ws: WebSocket, message: WSServerMessage) => void;
  sendResult: (ws: WebSocket, success: boolean, message: string) => void;
}

function unavailable(ctx: MemoryRouteContext, ws: WebSocket, type: string): void {
  if (type === 'memory.sage.delete') {
    ctx.sendResult(ws, false, 'Memory store not available');
    return;
  }
  ctx.send(ws, {
    type,
    payload: {
      ...(type === 'memory.list' ? { text: '' } : {}),
      ...(type === 'memory.sage.graph' ? { query: '' } : {}),
      error: 'Memory store not available',
    },
  });
}

/** Canonical Memory/Sage routing and unavailable-store behavior. */
export async function handleMemoryRoute(
  ctx: MemoryRouteContext,
  ws: WebSocket,
  message: WSClientMessage,
): Promise<boolean> {
  if (message.type !== 'memory.list' && !message.type.startsWith('memory.sage.')) return false;
  const store = ctx.getMemoryStore();
  if (!store) {
    unavailable(ctx, ws, message.type);
    return true;
  }
  switch (message.type) {
    case 'memory.list':
      await handleMemoryList(ws, message, store);
      return true;
    case 'memory.sage.list':
      await handleSageList(ws, message, store);
      return true;
    case 'memory.sage.listPage':
      await handleSageListPage(ws, message, store);
      return true;
    case 'memory.sage.get':
      await handleSageGet(ws, message, store);
      return true;
    case 'memory.sage.graph':
      await handleSageGraph(ws, message, store);
      return true;
    case 'memory.sage.update':
      await handleSageUpdate(ws, message, store);
      return true;
    case 'memory.sage.delete':
      await handleSageDelete(ws, message, store);
      return true;
    case 'memory.sage.remember':
      await handleSageRemember(ws, message, store);
      return true;
    case 'memory.sage.recover':
      await handleSageRecover(ws, message, store);
      return true;
    case 'memory.sage.listCandidates':
      await handleSageListCandidates(ws, message, store);
      return true;
    case 'memory.sage.candidateResolve':
      await handleSageCandidateResolve(ws, message, store);
      return true;
    case 'memory.sage.backfillRecoverable':
      await handleSageBackfillRecoverable(ws, message, store);
      return true;
    case 'memory.sage.forFile':
      await handleSageForFile(ws, message, store);
      return true;
    case 'memory.sage.searchBreakdown':
      await handleSageSearchBreakdown(ws, message, store);
      return true;
    default:
      return false;
  }
}
