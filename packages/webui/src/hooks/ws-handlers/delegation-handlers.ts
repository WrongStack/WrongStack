import {
  formatAutoWakeNotice,
  formatAutoWakeSuppressedNotice,
  formatDeliveryPendingNotice,
} from '@wrongstack/webui-protocol';
import { toast } from '@/components/Toaster';
import { truncateDelegateTask } from '@/lib/delegate-format';
import { chatFor, pipeViz } from '@/lib/ws-client-utils';
import { useFleetStore } from '@/stores';
import { activeLaneId, type ChatLaneActions } from '@/stores/chat-lanes';
import { useToolStatsStore } from '@/stores/tool-stats-store';
import type { WSServerMessage } from '@/types';

/**
 * A toast is a foreground interruption. Firing one for a background tab is a
 * cross-tab bleed the user cannot even act on — they would have to guess which
 * of the four tabs it came from. The owning tab's transcript still records the
 * event, and its strip entry shows the state.
 */
export function toastIfForeground(chat: ChatLaneActions, emit: () => void): void {
  if (chat.sessionId === activeLaneId()) emit();
}

export function handleDelegateStarted(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  pipeViz(msg);
  const p = msg.payload as { target: string; task: string; subagentId?: string | undefined };
  const task = truncateDelegateTask(p.task);
  const subagentId = p.subagentId ?? p.target;
  const fleet = useFleetStore.getState();
  fleet.applyEvent({
    kind: 'spawned',
    subagentId,
    name: p.target,
    description: task,
    sessionId: chat.sessionId,
  });
  useToolStatsStore.getState().recordDelegateStarted(chat.sessionId, { target: p.target });
  fleet.applyEvent({
    kind: 'task_started',
    subagentId,
    name: p.target,
    description: task,
    sessionId: chat.sessionId,
  });
  fleet.pushAgentTimelineEntry({
    subagentId,
    agentName: p.target,
    content: task,
    kind: 'status',
    iteration: 0,
    ts: new Date().toISOString(),
    status: 'delegating',
    sessionId: chat.sessionId,
  });
}

export function handleDelegateCompleted(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  pipeViz(msg);
  const p = msg.payload as {
    target: string;
    task: string;
    ok: boolean;
    status?: string | undefined;
    summary: string;
    durationMs: number;
    iterations: number;
    toolCalls: number;
    costUsd?: number | undefined;
    subagentId?: string | undefined;
  };
  const fleet = useFleetStore.getState();
  const subagentId = p.subagentId ?? p.target;
  fleet.applyEvent({
    kind: 'task_completed',
    subagentId,
    name: p.target,
    sessionId: chat.sessionId,
    status: p.ok
      ? 'success'
      : p.status === 'timeout' || p.status === 'host_timeout'
        ? 'timeout'
        : 'failed',
    iterations: p.iterations,
    toolCalls: p.toolCalls,
    finalText: p.summary,
    ...(p.ok ? {} : { failureReason: p.status ?? 'failed' }),
  });
  useToolStatsStore.getState().recordDelegateCompleted(chat.sessionId, {
    target: p.target,
    ok: p.ok,
    toolCalls: p.toolCalls,
  });
  fleet.pushAgentTimelineEntry({
    subagentId,
    agentName: p.target,
    content: p.summary,
    kind: p.ok ? 'status' : 'error',
    iteration: p.iterations,
    ts: new Date().toISOString(),
    status: p.status ?? (p.ok ? 'completed' : 'failed'),
    sessionId: chat.sessionId,
  });
  if (!p.ok) toastIfForeground(chat, () => toast.warn(`Delegate failed: ${p.target}`));
}

function delegationIdsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/** A background delegation result is waiting for this session's leader. */
export function handleDelegationDeliveryPending(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const p = msg.payload as { count?: unknown; delegationIds?: unknown };
  const delegationIds = delegationIdsOf(p.delegationIds);
  const count =
    typeof p.count === 'number' && Number.isFinite(p.count) ? p.count : delegationIds.length || 1;
  chat.addMessage({ role: 'system', content: formatDeliveryPendingNotice(delegationIds, count) });
}

/**
 * The runtime woke the leader. Rendered as a system line BEFORE the woken
 * turn's stream — never as a user bubble: nobody typed the `[AUTO-WAKE]`
 * prompt that drives it.
 */
export function handleDelegationAutoWakeStarted(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const p = msg.payload as { delegationIds?: unknown; notices?: unknown; chain?: unknown };
  const chain = typeof p.chain === 'number' ? p.chain : undefined;
  chat.addMessage({
    role: 'system',
    content: formatAutoWakeNotice(
      delegationIdsOf(p.delegationIds),
      chain,
      delegationIdsOf(p.notices),
    ),
  });
}

/** The chain cap is holding results until the user sends a message. */
export function handleDelegationAutoWakeSuppressed(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const p = msg.payload as { reason?: unknown; pending?: unknown };
  if (p.reason !== 'chain_cap') return;
  const pending = typeof p.pending === 'number' ? p.pending : 1;
  chat.addMessage({ role: 'system', content: formatAutoWakeSuppressedNotice(pending) });
  toastIfForeground(chat, () => toast.info('Auto-wake paused — send a message to continue'));
}
