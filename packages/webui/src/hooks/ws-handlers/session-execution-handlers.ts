import { isFinalTurnStopReason } from '@wrongstack/tools/next-steps';
import { toast } from '@/components/Toaster';
import { truncateDelegateTask } from '@/lib/delegate-format';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { chatFor, isActiveSessionMessage, pipeViz, sessionFor } from '@/lib/ws-client-utils';
import type { ProviderAuditEntry, SessionHistoryEntry } from '@/stores';
import {
  useConfigStore,
  useFallbackStore,
  useFleetStore,
  useHistoryStore,
  useProviderStatusStore,
  useSessionTabStore,
} from '@/stores';
import { activeLaneId, type ChatLaneActions, readLane } from '@/stores/chat-lanes';
import { activeSessionLaneId, SESSION_DEFAULT_LANE_ID } from '@/stores/session-lanes';
import { useToolStatsStore } from '@/stores/tool-stats-store';
import { useVizStore } from '@/stores/viz-store';
import type { WSServerMessage } from '@/types';
import { providerResponseText } from './session-replay-handlers';

/**
 * A toast is a foreground interruption. Firing one for a background tab is a
 * cross-tab bleed the user cannot even act on — they would have to guess which
 * of the four tabs it came from. The owning tab's transcript still records the
 * event, and its strip entry shows the state.
 */
function toastIfForeground(chat: ChatLaneActions, emit: () => void): void {
  if (chat.sessionId === activeLaneId()) emit();
}

export function truncateLine(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A provider response carries the run's usage AND its final text. Both belong
 * to the session that produced them.
 *
 * There used to be an explicit "is this a background tab?" branch here that
 * hand-folded usage into a parked snapshot and returned early. Lanes make that
 * branch unnecessary: the write is addressed either way, so a background run's
 * tokens, cost and reply land in its own tab and the foreground never sees
 * them until the user switches to it.
 */
export function handleProviderResponse(msg: WSServerMessage) {
  const chat = chatFor(msg);
  const meta = sessionFor(msg);
  if (!chat || !meta) return;
  pipeViz(msg);
  const payload = msg.payload as {
    usage: {
      input: number;
      output: number;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    };
    provider?: string | undefined;
    stopReason: string;
    messageId: string;
    content?: unknown;
  };
  const responseText = providerResponseText(payload.content);

  const u = payload.usage;
  const delta = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  if (delta > 0) meta.patch({ lastInputTokens: delta });

  meta.updateUsage(payload.usage, payload.provider);
  const { inputCost, outputCost, cacheReadCost } = meta.data;
  const dCost =
    (payload.usage.input * inputCost +
      (payload.usage.cacheWrite ?? 0) * inputCost +
      payload.usage.output * outputCost +
      (payload.usage.cacheRead ?? 0) * cacheReadCost) /
    1_000_000;
  if (dCost > 0) meta.addCost(dCost);

  const final = isFinalTurnStopReason(payload.stopReason);
  if (final) chat.setLoading(false);
  const id = chat.currentAssistantMessageId;
  if (id) {
    streamCoalescer.flush(id);
    const streamed = chat.messages.find((m) => m.id === id);
    const streamedText = streamed?.content ?? '';
    if (responseText.trim()) {
      if (!streamedText.trim()) {
        chat.updateMessage(id, { content: responseText });
      } else if (
        responseText.startsWith(streamedText) &&
        responseText.length > streamedText.length
      ) {
        chat.updateMessage(id, { content: responseText });
      }
    }
    chat.finalizeMessage(id, { final });
    if (payload.usage.output > 0) chat.updateMessage(id, { usage: payload.usage });
  } else if (responseText.trim()) {
    const messageId = chat.addMessage({
      role: 'assistant',
      content: responseText,
      usage: payload.usage.output > 0 ? payload.usage : undefined,
    });
    chat.finalizeMessage(messageId, { final });
  }
  chat.setCurrentAssistantMessage(null);
  streamCoalescer.flush(`__thinking__:${chat.sessionId}`);
  chat.clearThinking();
}

export function handleIterationCompleted(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  pipeViz(msg);
  const p = msg.payload as { index: number; totalIterations?: number | undefined };
  streamCoalescer.flush(`__thinking__:${chat.sessionId}`);
  chat.flushThinkingLog(p.index);
  chat.clearThinking();
  const meta = sessionFor(msg);
  const current = meta?.data.iteration;
  if (meta && current) meta.setIteration({ index: p.index, max: current.max });
}

export function handleIterationLimitReached(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const p = msg.payload as { currentIterations: number; currentLimit: number };
  chat.addMessage({
    role: 'assistant',
    content: `Iteration limit reached: ${p.currentIterations}/${p.currentLimit}.`,
    isError: true,
  });
  toastIfForeground(chat, () =>
    toast.warn(`Iteration limit reached (${p.currentIterations}/${p.currentLimit})`),
  );
}

export function handleProviderRetry(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const payload = msg.payload as {
    providerId: string;
    attempt: number;
    delayMs: number;
    status: number;
    description: string;
  };
  const seconds = Math.max(0, Math.round(payload.delayMs / 100) / 10);
  // A retry belongs to the run that hit it. Announced page-wide, a background
  // tab's backoff reads as a stall in the conversation the user is watching.
  toastIfForeground(chat, () =>
    toast.warn(
      `${payload.providerId} retry ${payload.attempt} after ${seconds}s (${payload.status})`,
    ),
  );
}

export function handleProviderError(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const payload = msg.payload as {
    providerId: string;
    status: number;
    description: string;
    retryable: boolean;
  };
  chat.addMessage({
    role: 'assistant',
    content: [
      `Provider error from \`${payload.providerId}\` (${payload.status}).`,
      payload.description,
      payload.retryable ? '_Retryable; WrongStack may recover automatically._' : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    isError: true,
  });
  toastIfForeground(chat, () =>
    toast.error(`${payload.providerId} provider error (${payload.status})`),
  );
}

/**
 * Record a provider/model change on the lane that made it, and update the
 * global chip only when that lane is the one on screen.
 *
 * `useConfigStore` holds ONE provider/model pair — it is what the top-bar chip,
 * the model switcher's "current" and the refiner's model label all read. Both
 * callers below used to write it unconditionally, so a background tab hitting a
 * provider fallback (or a model switch answered late) silently relabelled the
 * tab the user was looking at, and the switcher offered to change a model that
 * tab was not running.
 */
function recordRouteChange(
  chat: ChatLaneActions,
  msg: WSServerMessage,
  to: { providerId: string; model: string },
): void {
  const meta = sessionFor(msg);
  const current = meta?.data.session;
  if (meta && current) {
    meta.setSession({ ...current, provider: to.providerId, model: to.model });
  }
  if (chat.sessionId === activeLaneId()) {
    useConfigStore.getState().setConfig({ provider: to.providerId, model: to.model });
  }
}

export function handleProviderFallback(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const payload = msg.payload as {
    from: { providerId: string; model: string };
    to: { providerId: string; model: string };
    status: number;
    providerSwitched: boolean;
    requestId?: string | undefined;
  };
  const from = `${payload.from.providerId}/${payload.from.model}`;
  const to = `${payload.to.providerId}/${payload.to.model}`;
  recordRouteChange(chat, msg, payload.to);
  chat.addMessage({
    role: 'assistant',
    content: `Provider fallback: \`${from}\` returned ${payload.status}; switching to \`${to}\`${payload.providerSwitched ? ' with provider change' : ''}.`,
  });
  toastIfForeground(chat, () => toast.warn(`Fallback to ${to}`));
  // The switch settled the question. Retire the copy parked on the tab that
  // asked it, wherever that tab is, so it cannot reopen as a dead dialog on
  // the next switch.
  const parked = readLane(chat.sessionId).pendingFallback;
  if (parked) chat.setPendingFallback(null);
  const pending = useFallbackStore.getState().pending;
  if (!pending) return;
  // …and take the VISIBLE dialog down only when it is this tab's.
  if (chat.sessionId !== activeLaneId()) return;
  const sameFrom =
    pending.from.providerId === payload.from.providerId &&
    pending.from.model === payload.from.model;
  if (!sameFrom) return;
  if (typeof payload.requestId === 'string' && payload.requestId.length > 0) {
    if (pending.requestId !== payload.requestId) return;
  }
  useFallbackStore.getState().clear();
}

export function handleProviderModelSwitched(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const payload = msg.payload as {
    from?: { providerId: string; model: string } | undefined;
    to: { providerId: string; model: string };
    timestamp: number;
  };
  const to = `${payload.to.providerId}/${payload.to.model}`;
  const from = payload.from ? `${payload.from.providerId}/${payload.from.model}` : '';
  recordRouteChange(chat, msg, payload.to);
  chat.addMessage({
    role: 'assistant',
    content: from ? `Model switched: \`${from}\` → \`${to}\`` : `Model switched to \`${to}\``,
  });
  toastIfForeground(chat, () => toast.info(`Model: ${to}`));
}

export function handleProviderFallbackPending(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const payload = msg.payload as {
    from: { providerId: string; model: string };
    status: number;
    candidates: Array<{ providerId: string; model: string }>;
    autoSwitchSeconds: number;
    requestId: string;
  };
  const prompt = {
    requestId: payload.requestId,
    from: payload.from,
    status: payload.status,
    candidates: payload.candidates,
    autoSwitchSeconds: payload.autoSwitchSeconds,
    timestamp: Date.now(),
  };
  // Park it on the tab that hit the failure. This used to be dropped outright
  // for a background tab, so its run waited behind a question nobody could
  // answer until the server's countdown switched the model on its own — a
  // route change the user never chose, on a conversation they never saw.
  chat.setPendingFallback(prompt);
  if (chat.sessionId === activeLaneId()) {
    useFallbackStore.getState().setPending(prompt);
    return;
  }
  useSessionTabStore.getState().setAttention(chat.sessionId, true);
}

export function handleProviderStatusChanged(msg: WSServerMessage) {
  const payload = msg.payload as {
    providerId: string;
    model: string;
    oldState: 'healthy' | 'degraded' | 'blocked';
    newState: 'healthy' | 'degraded' | 'blocked';
    reason: string;
    timestamp: number;
    stateExpiresAt?: number | undefined;
    lastErrorKind?: string | undefined;
    lastErrorStatus?: number | null | undefined;
    lastErrorMessage?: string | null | undefined;
    lastSessionId?: string | null | undefined;
    lastAgentId?: string | null | undefined;
  };
  useProviderStatusStore.getState().update({
    providerId: payload.providerId,
    model: payload.model,
    state: payload.newState,
    reason: payload.reason,
    updatedAt: payload.timestamp,
    stateExpiresAt: payload.stateExpiresAt,
    // Real-time error context for the room's last-error line and the
    // sibling-quarantine chip (nulls normalize to undefined).
    lastErrorKind: payload.lastErrorKind,
    lastErrorStatus: payload.lastErrorStatus ?? undefined,
    lastErrorMessage: payload.lastErrorMessage ?? undefined,
    lastSessionId: payload.lastSessionId ?? undefined,
    lastAgentId: payload.lastAgentId ?? undefined,
  });
  const ref = `${payload.providerId}/${payload.model}`;
  if (payload.newState === 'blocked' && payload.oldState !== 'blocked') {
    toast.warn(`${ref} entered the limit-reset waiting room`);
  } else if (payload.newState === 'healthy' && payload.oldState !== 'healthy') {
    toast.success(`${ref} recovered and rejoined model routing`);
  }
}

export function handleProviderStatusSnapshot(msg: WSServerMessage) {
  const payload = msg.payload;
  if (payload && typeof payload === 'object' && 'error' in payload) {
    useProviderStatusStore.getState().setError('Provider status tracking not available');
    return;
  }
  useProviderStatusStore.getState().applySnapshot(payload as Record<string, unknown>);
}

/** `provider.audit.history` — durable block/open tail for the waiting room. */
export function handleProviderAuditHistory(msg: WSServerMessage) {
  const payload = msg.payload as { lines?: unknown };
  const lines = Array.isArray(payload?.lines) ? payload.lines : [];
  const audit: ProviderAuditEntry[] = [];
  for (const raw of lines) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const providerId = typeof item['providerId'] === 'string' ? item['providerId'] : '';
    const model = typeof item['model'] === 'string' ? item['model'] : '';
    const from = item['from'];
    const to = item['to'];
    if (!providerId || !model) continue;
    if (from !== 'healthy' && from !== 'degraded' && from !== 'blocked') continue;
    if (to !== 'healthy' && to !== 'degraded' && to !== 'blocked') continue;
    const error = (item['error'] ?? null) as ProviderAuditEntry['error'];
    audit.push({
      ts: typeof item['ts'] === 'number' ? item['ts'] : 0,
      providerId,
      model,
      from,
      to,
      reason: typeof item['reason'] === 'string' ? item['reason'] : '',
      expiresAt: typeof item['expiresAt'] === 'number' ? item['expiresAt'] : null,
      error,
    });
  }
  useProviderStatusStore.getState().setAudit(audit);
}

export function handleProviderActiveBlocked(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const payload = msg.payload as {
    providerId: string;
    model: string;
    lastError: string;
  };
  chat.addMessage({
    role: 'assistant',
    content: `Waiting room skipped \`${payload.providerId}/${payload.model}\`. ${payload.lastError}`,
  });
}

export function handleProviderStreamError(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  pipeViz(msg);
  const p = msg.payload as { eventType: string; message: string };
  toastIfForeground(chat, () => toast.warn(`Provider stream event skipped: ${p.eventType}`));
  chat.addMessage({
    role: 'assistant',
    content: `Provider stream warning (${p.eventType}): ${p.message}`,
    isError: true,
  });
}

export function handleToolLoopDetected(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  pipeViz(msg);
  const p = msg.payload as {
    tools: string;
    repeatCount: number;
    iteration: number;
    kind?: string | undefined;
    action?: 'steer' | 'cut' | undefined;
    scope?: 'iteration' | 'call' | undefined;
  };
  const subject = p.tools || p.kind || 'assistant response';
  if (p.action === 'steer') {
    toastIfForeground(chat, () =>
      toast.info(`Possible repetition noticed for ${subject}; changing approach.`),
    );
    return;
  }
  chat.addMessage({
    role: 'assistant',
    content: `Loop guard stopped the turn: ${subject} made no progress ${p.repeatCount} time(s) (iteration ${p.iteration + 1}).`,
    isError: true,
  });
  toastIfForeground(chat, () => toast.warn('Loop guard stopped the turn'));
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

export function handleSessionDamaged(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const p = msg.payload as { sessionId: string; detail: string };
  chat.addMessage({
    role: 'assistant',
    content: `Session ${p.sessionId} is damaged: ${p.detail}`,
    isError: true,
  });
  toastIfForeground(chat, () => toast.error('Session damage detected'));
}

export function handleSessionRewound(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const p = msg.payload as {
    toPromptIndex: number;
    revertedFiles: string[];
    removedEvents: number;
  };
  chat.addMessage({
    role: 'assistant',
    content: `Session rewound to prompt #${p.toPromptIndex}. Removed ${p.removedEvents} event(s); reverted ${p.revertedFiles.length} file(s).`,
  });
  toastIfForeground(chat, () => toast.info('Session rewound'));
}

export function handleCheckpointWritten(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const p = msg.payload as { promptIndex: number; promptPreview: string; fileCount: number };
  toastIfForeground(chat, () =>
    toast.success(`Checkpoint #${p.promptIndex} written (${p.fileCount} file(s))`),
  );
}

export function handleInFlightStarted(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as { context: string };
  useVizStore.getState().pushEvent({
    id: `inflight_${Date.now()}`,
    kind: 'session:start',
    timestamp: Date.now(),
    source: 'session',
    target: 'leader',
    label: `In-flight: ${p.context}`,
    magnitude: 1,
    data: p,
    raw: msg.payload,
    flowGroup: 'session',
  });
}

export function handleInFlightEnded(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as { reason: 'clean' | 'aborted' | 'recovered' };
  if (p.reason === 'recovered') toast.info('Recovered previous in-flight operation');
}

export function handleSessionEnd() {
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('chat:session-end'));
  }
}

export function handleSessionsList(msg: WSServerMessage) {
  const payload = msg.payload as { sessions: SessionHistoryEntry[]; error?: string | undefined };
  // The catalogue is project-wide, so every tab may render the same rows —
  // but `isCurrent` is per-tab, and a frame carries exactly one answer to it.
  // `session.new` even broadcasts the list to every socket, which would tell
  // three other tabs that the newly opened session is theirs. Settle the flag
  // against the foreground session here, where it is actually known.
  const laneId = activeSessionLaneId();
  const foreground = laneId && laneId !== SESSION_DEFAULT_LANE_ID ? laneId : null;
  const entries = (payload.sessions ?? []).map((entry) => ({
    ...entry,
    isCurrent: foreground ? entry.id === foreground : entry.isCurrent,
  }));
  useHistoryStore.getState().setEntries(entries, payload.error ?? null);
}
