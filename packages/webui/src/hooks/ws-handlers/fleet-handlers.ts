import { projectFleetMessage } from '@wrongstack/webui-protocol';
import type { SubagentEvent } from '@/stores';
import { useFleetStore, useMonitorStore, useWorktreeStore } from '@/stores';
import type { LiveSession } from '@/stores/monitor-store';
import { useVizStore, wsToVizEvent } from '@/stores/viz-store';
import type { WorktreeHandleView, WorktreeOrphanView, WSServerMessage } from '@/types';
import { queryMailbox } from './files-mailbox-handlers.js';

export function handleWorktreeState(msg: WSServerMessage) {
  const p = msg.payload as { worktrees: WorktreeHandleView[]; baseBranch: string };
  useWorktreeStore.getState().setSnapshot(p.worktrees ?? [], p.baseBranch ?? '');
}

export function handleWorktreeEvent(msg: WSServerMessage) {
  const p = msg.payload as { kind: string; handleId: string; text: string; at: number };
  useWorktreeStore.getState().pushEvent(p);
}

export function handleWorktreeOrphans(msg: WSServerMessage) {
  const p = msg.payload as { orphans: WorktreeOrphanView[]; canClean: boolean; reason?: string };
  useWorktreeStore.getState().setOrphans(p.orphans ?? [], p.canClean ?? false, p.reason);
}

export function handleWorktreeCleanupResult(msg: WSServerMessage) {
  const p = msg.payload as { ok: boolean; removed: number; reason?: string };
  useWorktreeStore.getState().setCleanResult({ ...p, at: Date.now() });
}

export function handleWorktreeMergeResult(msg: WSServerMessage) {
  const p = msg.payload as {
    ok: boolean;
    branch: string;
    conflict?: boolean;
    conflictFiles?: string[];
    reason?: string;
  };
  useWorktreeStore.getState().setMergeResult({ ...p, at: Date.now() });
}

export function handleWorktreeDiffResult(msg: WSServerMessage) {
  const p = msg.payload as { dir: string; summary: import('@/types').WorktreeDiffSummary | null };
  useWorktreeStore.getState().setDiff(p.dir, p.summary);
}

export function handleSubagentEvent(msg: WSServerMessage) {
  useFleetStore.getState().applyEvent(msg.payload as SubagentEvent);
  const vizEv = wsToVizEvent('subagent.event', msg.payload as Record<string, unknown>);
  if (vizEv) {
    useVizStore.getState().pushEvent(vizEv);
    useVizStore.getState().setActive(true);
  }
}

export function handleFleetConcurrency(msg: WSServerMessage) {
  const p = projectFleetMessage(msg);
  if (p?.kind !== 'concurrency') return;
  useFleetStore.setState({
    fleetConcurrency: p.active,
    fleetConcurrencyMax: p.maximum,
    ...(p.maxSpawns !== undefined ? { fleetMaxSpawns: p.maxSpawns } : {}),
    ...(p.usedSpawns !== undefined ? { fleetUsedSpawns: p.usedSpawns } : {}),
    ...(p.remainingSpawns !== undefined ? { fleetRemainingSpawns: p.remainingSpawns } : {}),
    ...(p.effectiveSource !== undefined ? { fleetBudgetSource: p.effectiveSource } : {}),
    ...(p.checkpointMaxSpawns !== undefined
      ? { fleetCheckpointMaxSpawns: p.checkpointMaxSpawns }
      : {}),
    ...(p.ceilingMismatch !== undefined ? { fleetCeilingMismatch: p.ceilingMismatch } : {}),
  });
}

export function handleClientStatusUpdate(msg: WSServerMessage) {
  const projection = projectFleetMessage(msg);
  if (projection?.kind !== 'client-status') return;
  const payload = projection.status as {
    clientType?: string;
    clientId?: string;
    agentCount?: number;
    model?: string;
    mode?: string;
    toolCalls?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheTokens?: number;
    costUsd?: number;
    timestamp?: number;
  };

  useMonitorStore.getState().setCurrentSession({
    clientType: payload.clientType,
    clientId: payload.clientId,
    agentCount: payload.agentCount,
    model: payload.model,
    mode: payload.mode,
    toolCalls: payload.toolCalls,
    inputTokens: payload.inputTokens,
    outputTokens: payload.outputTokens,
    cacheTokens: payload.cacheTokens,
    costUsd: payload.costUsd,
    timestamp: payload.timestamp,
  });
}

export function handleSessionsStatusUpdate(msg: WSServerMessage) {
  const projection = projectFleetMessage(msg);
  if (projection?.kind !== 'sessions') return;
  useMonitorStore.getState().setLiveSessions(projection.sessions as LiveSession[]);

  // Throttle viz-store updates to at most once per second. The fleet snapshot
  // event triggers a full node/edge rebuild in the AgentFlow visualization,
  // which is expensive. Without throttling, the ~5s session-registry poll +
  // fs.watch (150ms debounce) + push-on-write cascade causes the viz graph to
  // churn constantly, making it impossible to read.
  const now = Date.now();
  // The project mailbox is cross-process, while mailbox events are emitted by
  // the process that performed the write. Refresh alongside the shared fleet
  // heartbeat so this WebUI discovers other terminals' agents and mail too.
  if (now - lastMailboxRefresh >= 5_000) {
    lastMailboxRefresh = now;
    queryMailbox();
  }
  if (now - lastVizSnapshot < 1000) return;
  lastVizSnapshot = now;

  const vizEv = wsToVizEvent('sessions.status_update', msg.payload as Record<string, unknown>);
  if (vizEv) {
    useVizStore.getState().pushEvent(vizEv);
    useVizStore.getState().setActive(true);
  }
}

/** Throttle gate for viz-store fleet snapshot updates. */
let lastVizSnapshot = 0;
let lastMailboxRefresh = 0;

export const fleetHandlerMap: Partial<Record<string, (msg: WSServerMessage) => void>> = {
  'worktree.state': handleWorktreeState,
  'worktree.event': handleWorktreeEvent,
  'worktree.orphans': handleWorktreeOrphans,
  'worktree.cleanup_result': handleWorktreeCleanupResult,
  'worktree.merge_result': handleWorktreeMergeResult,
  'worktree.diff_result': handleWorktreeDiffResult,
  'subagent.event': handleSubagentEvent,
  'fleet.concurrency_update': handleFleetConcurrency,
  'client.status_update': handleClientStatusUpdate,
  'sessions.status_update': handleSessionsStatusUpdate,
};
