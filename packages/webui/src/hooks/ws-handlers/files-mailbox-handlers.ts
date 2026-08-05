import { toast } from '@/components/Toaster';
import { getWSClient } from '@/lib/ws-client';
import { useFileStore } from '@/stores';
import type { TreeNode } from '@/stores/file-store';
import { type MailboxAgent, type MailboxMessage, useMailboxStore } from '@/stores/mailbox-store';
import { useVizStore, wsToVizEvent } from '@/stores/viz-store';
import type { WSServerMessage } from '@/types';

function queryMailbox() {
  const ws = getWSClient();
  ws?.send?.({ type: 'mailbox.messages', payload: { limit: 30, incompleteOnly: true } });
  ws?.send?.({ type: 'mailbox.agents', payload: {} });
}

/**
 * Debounced mailbox refresh — collapses rapid bursts of mailbox events
 * (e.g. a subagent sending 5 results) into a single refresh. The 300ms
 * window is short enough that the panel feels real-time but avoids
 * hammering the WS with redundant query requests on every event.
 */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedRefresh(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    queryMailbox();
  }, 300);
}

export { debouncedRefresh, queryMailbox };

export function handleFilesTree(msg: WSServerMessage) {
  const p = msg.payload as { root: string; tree: TreeNode[]; error?: string | undefined };
  if (p.error) {
    useFileStore.getState().setError(p.error);
    return;
  }
  useFileStore.getState().setTree(p.root, p.tree);
}

export function handleFilesRead(msg: WSServerMessage) {
  const p = msg.payload as { filePath: string; content: string; error?: string | undefined };
  if (p.error) {
    useFileStore.getState().setError(p.error);
    return;
  }
  useFileStore.getState().openFile(p.filePath, p.content);
}

export function handleFilesWritten(msg: WSServerMessage) {
  const p = msg.payload as { filePath: string; success: boolean; error?: string | undefined };
  if (p.success) {
    useFileStore.getState().markSaved(p.filePath);
  } else if (p.error) {
    useFileStore.getState().setError(`Save failed: ${p.error}`);
  }
}

export function handleMailboxEvent(msg: WSServerMessage) {
  const vizEv = wsToVizEvent('mailbox.event', msg.payload as Record<string, unknown>);
  if (vizEv) {
    useVizStore.getState().pushEvent(vizEv);
    useVizStore.getState().setActive(true);
  }
  // Smart refresh: 'message_sent' events are high-frequency when multiple
  // agents are active. Debounce avoids redundant WS query bursts.
  debouncedRefresh();
}

export function handleMailboxMessages(msg: WSServerMessage) {
  const p = msg.payload as { messages?: MailboxMessage[] } | undefined;
  if (p?.messages) useMailboxStore.getState().setMessages(p.messages);
}

export function handleMailboxAgents(msg: WSServerMessage) {
  const p = msg.payload as { agents?: MailboxAgent[] } | undefined;
  if (p?.agents) useMailboxStore.getState().setAgents(p.agents);
}

export function handleMailboxReceived(msg: WSServerMessage) {
  const vizEv = wsToVizEvent('mailbox.received', msg.payload as Record<string, unknown>);
  if (vizEv) {
    useVizStore.getState().pushEvent(vizEv);
    useVizStore.getState().setActive(true);
  }
  debouncedRefresh();
}

export function handleMailboxAgentRegistered(_msg: WSServerMessage) {
  debouncedRefresh();
}

export function handleMailboxAgentDeregistered(msg: WSServerMessage) {
  const p = msg.payload as { agentId?: string } | undefined;
  if (!p?.agentId) return;
  // Immediate removal — the server already deleted the registration row, so
  // a refresh would also drop it, but waiting for the next unrelated mailbox
  // event is what leaves dead reviewers visible in the roster for minutes.
  useMailboxStore.getState().removeAgent(p.agentId);
}

export function handleMailboxCleared(_msg: WSServerMessage) {
  useMailboxStore.getState().setMessages([]);
  queryMailbox();
}

export function handleMailboxPurged(_msg: WSServerMessage) {
  debouncedRefresh();
}

export function handleMailboxCompacted(msg: WSServerMessage) {
  const p = msg.payload as
    | {
        readByAllRemoved?: number;
        expiredRemoved?: number;
        stalePurged?: number;
        totalRemoved?: number;
        remaining?: number;
      }
    | undefined;
  if (p && typeof p.totalRemoved === 'number') {
    useMailboxStore.getState().setLastCompaction({
      readByAllRemoved: p.readByAllRemoved ?? 0,
      expiredRemoved: p.expiredRemoved ?? 0,
      stalePurged: p.stalePurged ?? 0,
      totalRemoved: p.totalRemoved,
      remaining: p.remaining ?? 0,
    });
  }
  debouncedRefresh();
}

export function handleMailboxActionResult(msg: WSServerMessage) {
  const p = msg.payload as { success?: boolean; error?: string | undefined } | undefined;
  if (p?.success) {
    debouncedRefresh();
    return;
  }
  toast.error(`Mailbox action failed: ${p?.error ?? 'unknown error'}`);
}

export const filesMailboxHandlerMap: Partial<Record<string, (msg: WSServerMessage) => void>> = {
  'files.tree': handleFilesTree,
  'files.read': handleFilesRead,
  'files.written': handleFilesWritten,
  'mailbox.event': handleMailboxEvent,
  'mailbox.messages': handleMailboxMessages,
  'mailbox.agents': handleMailboxAgents,
  'mailbox.received': handleMailboxReceived,
  'mailbox.agent_registered': handleMailboxAgentRegistered,
  'mailbox.agent_deregistered': handleMailboxAgentDeregistered,
  'mailbox.cleared': handleMailboxCleared,
  'mailbox.purged': handleMailboxPurged,
  'mailbox.compacted': handleMailboxCompacted,
  'mailbox.action_result': handleMailboxActionResult,
};
