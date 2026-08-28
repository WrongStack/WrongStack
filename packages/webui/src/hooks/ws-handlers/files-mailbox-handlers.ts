import { toast } from '@/components/Toaster';
import { getWSClient } from '@/lib/ws-client';
import { messageSessionId } from '@/lib/ws-client-utils';
import { activeSessionLaneId, useFileStore, useSessionStore } from '@/stores';
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

function withSessionPayload<T extends Record<string, unknown>>(
  payload: T,
  sessionId: string | null | undefined,
): T & { sessionId?: string } {
  return sessionId ? { ...payload, sessionId } : payload;
}

function isHydratingFile(filePath: string, sessionId: string | null): boolean {
  const store = useFileStore.getState();
  if (sessionId && store.fileSessionId !== sessionId) {
    return store.filesBySession[sessionId]?.hydratingPaths.has(filePath) ?? false;
  }
  return store.hydratingPaths.has(filePath);
}

/**
 * Reconcile rehydrated editor tabs once the server environment is known.
 *
 * Tabs persist as path-only stubs (content is never trusted across a reload
 * — stale cached content would silently overwrite on-disk changes on the
 * next save). After a reload their content is empty and must be re-fetched
 * from disk before the user edits or saves. When the canonical project
 * identity (`projectIdentity`, an absolute env root — NOT the `projectRoot`
 * display label, which can be a cwd-relative label) differs from the server
 * root, the tabs belong to a different project and are dropped instead of
 * restored. Re-fetch responses route through `hydrateFileContent`, which
 * never steals focus and never overwrites mid-flight user edits.
 */
export function reconcileFileTabsAfterEnvChange(
  projectRoot: string,
  sessionId: string | null = activeSessionLaneId() ?? useSessionStore.getState().session?.id ?? null,
): void {
  const store = useFileStore.getState();
  const fileSession =
    sessionId && store.fileSessionId !== sessionId ? store.filesBySession[sessionId] : store;
  const openFiles = fileSession?.openFiles ?? [];
  const projectIdentity = fileSession?.projectIdentity ?? '';
  if (openFiles.length === 0) {
    store.setProjectIdentity(projectRoot, sessionId);
    return;
  }
  if (projectIdentity && projectIdentity !== projectRoot) {
    store.clearOpenTabs(sessionId);
    store.setProjectIdentity(projectRoot, sessionId);
    return;
  }
  store.setProjectIdentity(projectRoot, sessionId);
  const stubPaths = openFiles.filter((f) => f.content === '' && !f.dirty).map((f) => f.path);
  if (stubPaths.length === 0) return;
  useFileStore.getState().setHydratingPaths(stubPaths, sessionId);
  const ws = getWSClient();
  for (const filePath of stubPaths) {
    ws?.send?.({
      type: 'files.read',
      payload: withSessionPayload({ filePath }, sessionId),
    });
  }
}

export function handleFilesTree(msg: WSServerMessage) {
  const p = msg.payload as { root: string; tree: TreeNode[]; error?: string | undefined };
  const sessionId = messageSessionId(msg);
  if (p.error) {
    useFileStore.getState().setError(p.error, sessionId);
    return;
  }
  useFileStore.getState().setTree(p.root, p.tree, sessionId);
}

export function handleFilesRead(msg: WSServerMessage) {
  const p = msg.payload as {
    filePath: string;
    content: string;
    binary?: boolean | undefined;
    tooLarge?: boolean | undefined;
    error?: string | undefined;
  };
  const sessionId = messageSessionId(msg);
  const store = useFileStore.getState();
  if (p.error) {
    // A hydration read whose file vanished on disk: drop the dead stub
    // instead of leaving an empty tab that the next save would resurrect.
    if (isHydratingFile(p.filePath, sessionId)) {
      store.hydrateFileFailed(p.filePath, sessionId);
      return;
    }
    store.setError(p.error, sessionId);
    return;
  }
  // Size/binary guard (mirrors handleGitDiff): the server flags these
  // instead of returning content — never open an editor tab for them. A
  // rehydrated stub for an unopenable file is a dead tab; drop it like a
  // vanished file.
  if (p.binary || p.tooLarge) {
    if (isHydratingFile(p.filePath, sessionId)) {
      store.hydrateFileFailed(p.filePath, sessionId);
      return;
    }
    store.setError(
      p.binary
        ? `Binary file not displayed: ${p.filePath}`
        : `File exceeds the 2 MB display limit: ${p.filePath}`,
      sessionId,
    );
    return;
  }
  // Hydration reads (rehydrated stub tabs) go through the guarded path:
  // they never steal focus and never overwrite user edits made mid-flight.
  if (isHydratingFile(p.filePath, sessionId)) {
    store.hydrateFileContent(p.filePath, p.content, sessionId);
    return;
  }
  store.openFile(p.filePath, p.content, sessionId);
}

export function handleFilesWritten(msg: WSServerMessage) {
  const p = msg.payload as { filePath: string; success: boolean; error?: string | undefined };
  const sessionId = messageSessionId(msg);
  if (p.success) {
    useFileStore.getState().markSaved(p.filePath, sessionId);
  } else if (p.error) {
    useFileStore.getState().setError(`Save failed: ${p.error}`, sessionId);
  }
}

export function handleFilesCreated(msg: WSServerMessage) {
  const p = msg.payload as { filePath: string; success: boolean; error?: string | undefined };
  if (!p.success && p.error) {
    useFileStore.getState().setError(`Create failed: ${p.error}`, messageSessionId(msg));
  }
  // On success, the project watcher broadcasts files.tree.changed
  // which triggers a tree refresh — no explicit action needed here.
}

export function handleFilesDeleted(msg: WSServerMessage) {
  const p = msg.payload as { filePath: string; success: boolean; error?: string | undefined };
  const sessionId = messageSessionId(msg);
  if (p.success) {
    // Close any open editor tab for the deleted file
    useFileStore.getState().closeFile(p.filePath, sessionId);
  } else if (p.error) {
    useFileStore.getState().setError(`Delete failed: ${p.error}`, sessionId);
  }
}

function handleFilesRenamed(msg: WSServerMessage) {
  const p = msg.payload as {
    oldPath: string;
    newPath: string;
    success: boolean;
    error?: string | undefined;
  };
  const sessionId = messageSessionId(msg);
  if (p.success) {
    // If the renamed file was open in an editor tab, close the old tab
    // (the tree watcher will refresh and the user can reopen at the new path).
    useFileStore.getState().closeFile(p.oldPath, sessionId);
  } else if (p.error) {
    useFileStore.getState().setError(`Rename failed: ${p.error}`, sessionId);
  }
}

function handleFilesMoved(msg: WSServerMessage) {
  const p = msg.payload as {
    srcPath: string;
    destPath: string;
    success: boolean;
    error?: string | undefined;
  };
  const sessionId = messageSessionId(msg);
  if (p.success) {
    useFileStore.getState().closeFile(p.srcPath, sessionId);
  } else if (p.error) {
    useFileStore.getState().setError(`Move failed: ${p.error}`, sessionId);
  }
}

/**
 * The server's project watcher detected a filesystem change. Re-request
 * the tree for the current working directory so the explorer refreshes
 * live. The tree store's `setTree` preserves the user's expansion state
 * (managed in FileExplorer component state, keyed by directory path).
 *
 * The re-request is debounced client-side: the server's project watcher
 * already debounces its `files.tree.changed` broadcasts (400ms), but
 * separate watcher events and overlapping create/delete bursts can still
 * land back-to-back; coalescing here keeps the explorer from firing a
 * burst of `files.tree` round-trips (and intermediate loading flickers).
 */
let treeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const TREE_REFRESH_DEBOUNCE_MS = 500;

export function handleFilesTreeChanged(_msg: WSServerMessage) {
  const sessionId = messageSessionId(_msg);
  if (treeRefreshTimer) clearTimeout(treeRefreshTimer);
  treeRefreshTimer = setTimeout(() => {
    treeRefreshTimer = null;
    const cwd = useSessionStore.getState().cwd;
    useFileStore.getState().setTreeLoading(true, sessionId);
    getWSClient().send({
      type: 'files.tree',
      payload: withSessionPayload({ path: cwd }, sessionId),
    });
  }, TREE_REFRESH_DEBOUNCE_MS);
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
  'files.tree.changed': handleFilesTreeChanged,
  'files.read': handleFilesRead,
  'files.written': handleFilesWritten,
  'files.created': handleFilesCreated,
  'files.deleted': handleFilesDeleted,
  'files.renamed': handleFilesRenamed,
  'files.moved': handleFilesMoved,
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
