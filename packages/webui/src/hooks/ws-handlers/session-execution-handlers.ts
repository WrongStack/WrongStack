import { isFinalTurnStopReason } from '@wrongstack/tools/next-steps';
import { toast } from '@/components/Toaster';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { isActiveSessionMessage, pipeViz } from '@/lib/ws-client-utils';
import type { SessionHistoryEntry } from '@/stores';
import {
  useChatStore,
  useConfigStore,
  useFallbackStore,
  useFleetStore,
  useHistoryStore,
  useProviderStatusStore,
  useSessionStore,
} from '@/stores';
import { useVizStore } from '@/stores/viz-store';
import type { WSServerMessage } from '@/types';
import { providerResponseText } from './session-replay-handlers';

export function truncateLine(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function handleProviderResponse(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
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
  if (delta > 0) useSessionStore.setState({ lastInputTokens: delta });

  useSessionStore.getState().updateUsage(payload.usage, payload.provider);
  const { inputCost, outputCost, cacheReadCost } = useSessionStore.getState();
  const dCost =
    (payload.usage.input * inputCost +
      (payload.usage.cacheWrite ?? 0) * inputCost +
      payload.usage.output * outputCost +
      (payload.usage.cacheRead ?? 0) * cacheReadCost) /
    1_000_000;
  if (dCost > 0) useSessionStore.getState().addCost(dCost);

  const final = isFinalTurnStopReason(payload.stopReason);
  if (final) useChatStore.getState().setLoading(false);
  const id = useChatStore.getState().currentAssistantMessageId;
  if (id) {
    streamCoalescer.flush(id);
    const streamed = useChatStore.getState().messages.find((m) => m.id === id);
    const streamedText = streamed?.content ?? '';
    if (responseText.trim()) {
      if (!streamedText.trim()) {
        useChatStore.getState().updateMessage(id, { content: responseText });
      } else if (
        responseText.startsWith(streamedText) &&
        responseText.length > streamedText.length
      ) {
        useChatStore.getState().updateMessage(id, { content: responseText });
      }
    }
    useChatStore.getState().finalizeMessage(id, { final });
    if (payload.usage.output > 0)
      useChatStore.getState().updateMessage(id, { usage: payload.usage });
  } else if (responseText.trim()) {
    const messageId = useChatStore.getState().addMessage({
      role: 'assistant',
      content: responseText,
      usage: payload.usage.output > 0 ? payload.usage : undefined,
    });
    useChatStore.getState().finalizeMessage(messageId, { final });
  }
  useChatStore.getState().setCurrentAssistantMessage(null);
  streamCoalescer.flush('__thinking__');
  useChatStore.getState().clearThinking();
}

export function handleIterationCompleted(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  pipeViz(msg);
  const p = msg.payload as { index: number; totalIterations?: number | undefined };
  streamCoalescer.flush('__thinking__');
  useChatStore.getState().flushThinkingLog(p.index);
  useChatStore.getState().clearThinking();
  const current = useSessionStore.getState().iteration;
  if (current) {
    useSessionStore.getState().setIteration({
      index: p.index,
      max: current.max,
    });
  }
}

export function handleIterationLimitReached(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as { currentIterations: number; currentLimit: number };
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `Iteration limit reached: ${p.currentIterations}/${p.currentLimit}.`,
    isError: true,
  });
  toast.warn(`Iteration limit reached (${p.currentIterations}/${p.currentLimit})`);
}

export function handleProviderRetry(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const payload = msg.payload as {
    providerId: string;
    attempt: number;
    delayMs: number;
    status: number;
    description: string;
  };
  const seconds = Math.max(0, Math.round(payload.delayMs / 100) / 10);
  toast.warn(
    `${payload.providerId} retry ${payload.attempt} after ${seconds}s (${payload.status})`,
  );
}

export function handleProviderError(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const payload = msg.payload as {
    providerId: string;
    status: number;
    description: string;
    retryable: boolean;
  };
  useChatStore.getState().addMessage({
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
  toast.error(`${payload.providerId} provider error (${payload.status})`);
}

export function handleProviderFallback(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const payload = msg.payload as {
    from: { providerId: string; model: string };
    to: { providerId: string; model: string };
    status: number;
    providerSwitched: boolean;
    requestId?: string | undefined;
  };
  const from = `${payload.from.providerId}/${payload.from.model}`;
  const to = `${payload.to.providerId}/${payload.to.model}`;
  useConfigStore.getState().setConfig({ provider: payload.to.providerId, model: payload.to.model });
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `Provider fallback: \`${from}\` returned ${payload.status}; switching to \`${to}\`${payload.providerSwitched ? ' with provider change' : ''}.`,
  });
  toast.warn(`Fallback to ${to}`);
  const pending = useFallbackStore.getState().pending;
  if (!pending) return;
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
  if (!isActiveSessionMessage(msg)) return;
  const payload = msg.payload as {
    from?: { providerId: string; model: string } | undefined;
    to: { providerId: string; model: string };
    timestamp: number;
  };
  const to = `${payload.to.providerId}/${payload.to.model}`;
  const from = payload.from ? `${payload.from.providerId}/${payload.from.model}` : '';
  useConfigStore.getState().setConfig({ provider: payload.to.providerId, model: payload.to.model });
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: from
      ? `Model switched: \`${from}\` → \`${to}\``
      : `Model switched to \`${to}\``,
  });
  toast.info(`Model: ${to}`);
}

export function handleProviderFallbackPending(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const payload = msg.payload as {
    from: { providerId: string; model: string };
    status: number;
    candidates: Array<{ providerId: string; model: string }>;
    autoSwitchSeconds: number;
    requestId: string;
  };
  useFallbackStore.getState().setPending({
    requestId: payload.requestId,
    from: payload.from,
    status: payload.status,
    candidates: payload.candidates,
    autoSwitchSeconds: payload.autoSwitchSeconds,
    timestamp: Date.now(),
  });
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
  };
  useProviderStatusStore.getState().update({
    providerId: payload.providerId,
    model: payload.model,
    state: payload.newState,
    reason: payload.reason,
    updatedAt: payload.timestamp,
    stateExpiresAt: payload.stateExpiresAt,
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

export function handleProviderActiveBlocked(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const payload = msg.payload as {
    providerId: string;
    model: string;
    lastError: string;
  };
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `Waiting room skipped \`${payload.providerId}/${payload.model}\`. ${payload.lastError}`,
  });
}

export function handleProviderStreamError(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  pipeViz(msg);
  const p = msg.payload as { eventType: string; message: string };
  toast.warn(`Provider stream event skipped: ${p.eventType}`);
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `Provider stream warning (${p.eventType}): ${p.message}`,
    isError: true,
  });
}

export function handleToolLoopDetected(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
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
    toast.info(`Possible repetition noticed for ${subject}; changing approach.`);
    return;
  }
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `Loop guard stopped the turn: ${subject} made no progress ${p.repeatCount} time(s) (iteration ${p.iteration + 1}).`,
    isError: true,
  });
  toast.warn('Loop guard stopped the turn');
}

export function handleDelegateStarted(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  pipeViz(msg);
  const p = msg.payload as { target: string; task: string; subagentId?: string | undefined };
  const task = truncateLine(p.task, 180);
  const subagentId = p.subagentId ?? p.target;
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `Delegating to \`${p.target}\`: ${task}`,
  });
  const fleet = useFleetStore.getState();
  fleet.applyEvent({
    kind: 'spawned',
    subagentId,
    name: p.target,
    description: task,
  });
  fleet.applyEvent({
    kind: 'task_started',
    subagentId,
    name: p.target,
    description: task,
  });
  fleet.pushAgentTimelineEntry({
    subagentId,
    agentName: p.target,
    content: task,
    kind: 'status',
    iteration: 0,
    ts: new Date().toISOString(),
    status: 'delegating',
  });
}

export function handleDelegateCompleted(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
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
  const seconds = Math.max(0, Math.round(p.durationMs / 100) / 10);
  const cost = typeof p.costUsd === 'number' && p.costUsd > 0 ? ` · $${p.costUsd.toFixed(4)}` : '';
  const stats = `${p.iterations} iteration(s), ${p.toolCalls} tool call(s), ${seconds}s${cost}`;
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: [
      `Delegate ${p.ok ? 'completed' : 'failed'} for \`${p.target}\`${p.status ? ` (${p.status})` : ''}.`,
      p.summary,
      stats,
    ].join('\n'),
    isError: !p.ok,
  });
  const fleet = useFleetStore.getState();
  const subagentId = p.subagentId ?? p.target;
  fleet.applyEvent({
    kind: 'task_completed',
    subagentId,
    name: p.target,
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
  fleet.pushAgentTimelineEntry({
    subagentId,
    agentName: p.target,
    content: p.summary,
    kind: p.ok ? 'status' : 'error',
    iteration: p.iterations,
    ts: new Date().toISOString(),
    status: p.status ?? (p.ok ? 'completed' : 'failed'),
  });
  if (!p.ok) toast.warn(`Delegate failed: ${p.target}`);
}

export function handleSessionDamaged(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as { sessionId: string; detail: string };
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `Session ${p.sessionId} is damaged: ${p.detail}`,
    isError: true,
  });
  toast.error('Session damage detected');
}

export function handleSessionRewound(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as {
    toPromptIndex: number;
    revertedFiles: string[];
    removedEvents: number;
  };
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `Session rewound to prompt #${p.toPromptIndex}. Removed ${p.removedEvents} event(s); reverted ${p.revertedFiles.length} file(s).`,
  });
  toast.info('Session rewound');
}

export function handleCheckpointWritten(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as { promptIndex: number; promptPreview: string; fileCount: number };
  toast.success(`Checkpoint #${p.promptIndex} written (${p.fileCount} file(s))`);
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
  useHistoryStore.getState().setEntries(payload.sessions ?? [], payload.error ?? null);
}
