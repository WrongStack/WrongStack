import { expectDefined } from '@wrongstack/core';
import { toast } from '@/components/Toaster';
import { playCompletionChime, playPermissionChime } from '@/lib/chime';
import { setFaviconStatus } from '@/lib/favicon';
import { ensureNotificationPermission, notifyIfHidden } from '@/lib/notify';
import { getWSClient } from '@/lib/ws-client';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { isActiveSessionMessage, pipeViz, safePayload } from '@/lib/ws-client-utils';
import { useChatStore, useConfigStore, useSessionStore, useUIStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import type { WSServerMessage } from '@/types';

export const chatHandlers = {
  handleIterationStarted,
  handleTextDelta,
  handleThinkingDelta,
  handleToolStarted,
  handleToolProgress,
  handleToolExecuted,
  handleToolConfirmNeeded,
  handleRunResult,
};

export const chatHandlerMap: Partial<Record<string, (msg: WSServerMessage) => void>> = {
  'iteration.started': handleIterationStarted,
  'provider.text_delta': handleTextDelta,
  'provider.thinking_delta': handleThinkingDelta,
  'tool.started': handleToolStarted,
  'tool.progress': handleToolProgress,
  'tool.executed': handleToolExecuted,
  'tool.confirm_needed': handleToolConfirmNeeded,
  'run.result': handleRunResult,
};

export function handleIterationStarted(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  pipeViz(msg);
  const payload = msg.payload as { index: number; maxIterations?: number | undefined };
  useSessionStore.getState().setIteration({ index: payload.index, max: payload.maxIterations ?? 0 });
  useChatStore.getState().setLoading(true);
  if (typeof document !== 'undefined' && document.hidden) setFaviconStatus('running');
  if (useChatStore.getState().runStart === null) {
    useChatStore.getState().setRunStart({ at: Date.now(), cost: useSessionStore.getState().cost });
  }
  useChatStore.getState().setCurrentAssistantMessage(null);
}

export function handleTextDelta(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  // Per-token viz push removed — text_delta fires dozens of times per
  // assistant message during streaming, and a per-token viz-store update
  // has no visible effect on the cinematic view (it scrolls past faster
  // than any frame budget). Iteration/tool/run-result events still pipe
  // through, so viz reflects the structural shape of the run.
  const payload = safePayload<{ text: string; messageId: string }>(msg, {
    text: 'string',
    messageId: 'string',
  });
  if (!payload) return;
  streamCoalescer.flush('__thinking__');
  useChatStore.getState().clearThinking();
  let id = useChatStore.getState().currentAssistantMessageId;
  if (!id) {
    id = useChatStore.getState().addMessage({ role: 'assistant', content: '', streaming: true });
    useChatStore.getState().setCurrentAssistantMessage(id);
  }
  streamCoalescer.push(id, payload.text, (mid, text) =>
    useChatStore.getState().appendToMessage(mid, text),
  );
}

export function handleThinkingDelta(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  // Per-token viz push removed (same reasoning as handleTextDelta).
  const payload = msg.payload as { text: string };
  if (!payload.text) return;
  streamCoalescer.push('__thinking__', payload.text, (_k, text) =>
    useChatStore.getState().appendThinking(text),
  );
}

export function handleToolStarted(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  pipeViz(msg);
  const payload = msg.payload as { id: string; name: string; input?: unknown | undefined; messageId: string };
  const existingId = useChatStore.getState().getToolMessageId(payload.id);
  if (existingId) { useChatStore.getState().setCurrentToolId(existingId); return; }
  streamCoalescer.flush('__thinking__');
  useChatStore.getState().clearThinking();
  useChatStore.getState().setCurrentAssistantMessage(null);
  const id = useChatStore.getState().addMessage({ role: 'tool', content: '', toolName: payload.name, toolInput: payload.input, toolUseId: payload.id });
  useChatStore.getState().setCurrentToolId(id);
  useChatStore.getState().addExecution({ id: payload.id, name: payload.name, input: payload.input, ok: true, startedAt: Date.now() });
}

export function handleToolProgress(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const payload = msg.payload as { id: string; name: string; event: { type: string; text?: string | undefined } };
  const text = (payload.event?.text ?? '').trim();
  if (!text) return;
  const ownerId = useChatStore.getState().getToolMessageId(payload.id);
  if (!ownerId) return;
  const prefix = payload.event?.type === 'warning' ? '⚠ ' : '';
  streamCoalescer.push(ownerId, `${prefix}${text}\n`, (_oid, buffered) =>
    useChatStore.getState().appendToolProgressLinesByUseId(
      payload.id,
      buffered.split('\n').filter((l) => l.length > 0),
    ),
  );
}

export function handleToolExecuted(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  pipeViz(msg);
  const payload = msg.payload as { id?: string | undefined; name: string; durationMs: number; ok: boolean; input?: unknown | undefined; output?: string | undefined };
  const { currentToolId } = useChatStore.getState();
  const ownerId = payload.id ? useChatStore.getState().getToolMessageId(payload.id) : currentToolId;
  if (ownerId) {
    streamCoalescer.drop(ownerId);
    if (payload.id) {
      useChatStore.getState().setToolResultByUseId(payload.id, payload.output ?? '', payload.ok);
    } else {
      useChatStore.getState().setToolResult(ownerId, payload.output ?? '', payload.ok);
    }
    useChatStore.getState().updateMessage(ownerId, { toolDurationMs: payload.durationMs });
  }
  if (payload.id) useChatStore.getState().updateExecution(payload.id, { completedAt: Date.now(), durationMs: payload.durationMs, output: payload.output, ok: payload.ok });
  if (currentToolId && ownerId === currentToolId) useChatStore.getState().setCurrentToolId(null);
}

export function handleToolConfirmNeeded(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const payload = msg.payload as {
    id: string;
    toolName: string;
    input: unknown;
    suggestedPattern: string;
    decisionSource?: string | undefined;
    riskTier?: 'safe' | 'standard' | 'destructive' | undefined;
  };
  if (
    useLocalPrefs.getState().yolo === true &&
    payload.riskTier !== 'destructive' &&
    payload.decisionSource !== 'yolo_destructive'
  ) {
    getWSClient(useConfigStore.getState().wsUrl).sendConfirm(payload.id, 'yes');
    useUIStore.getState().hideConfirm();
    return;
  }
  useUIStore.getState().showConfirm({
    id: payload.id,
    toolName: payload.toolName,
    input: payload.input,
    suggestedPattern: payload.suggestedPattern,
    decisionSource: payload.decisionSource,
    riskTier: payload.riskTier,
  });
  try { playPermissionChime(); } catch { /* audio policy */ }
  void ensureNotificationPermission();
  const label = useSessionStore.getState().projectName || 'Agent';
  notifyIfHidden(`${label} needs approval`, `Tool "${payload.toolName}" is waiting for your decision.`, 'agent-confirm');
  if (typeof document !== 'undefined' && document.hidden) setFaviconStatus('attention');
}

export function handleRunResult(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const payload = safePayload<{
    status: string;
    iterations?: number;
    finalText?: string;
    error?: { code?: string; message: string; recoverable: boolean };
  }>(
    msg,
    { status: 'string' },
    { iterations: 'number', finalText: 'string', error: 'object' },
  );
  if (!payload) return;
  // iterations is optional on the wire (some server builds omit it on
  // early-exit paths); default to 1 so downstream math + copy stays sane.
  const iterations = payload.iterations ?? 1;
  streamCoalescer.flushAll();
  useChatStore.getState().flushThinkingLog(Math.max(1, iterations));
  useSessionStore.getState().setIteration(null);
  useChatStore.getState().setLoading(false);
  // Finalize the streaming assistant message so the UI stops showing the
  // typing indicator. Previously the message stayed `streaming: true` even
  // after run.result, leaving a perpetual "typing…" bubble if no later
  // message superseded it.
  const streamingId = useChatStore.getState().currentAssistantMessageId;
  const finalText = payload.status === 'done' ? payload.finalText?.trim() : undefined;
  if (streamingId) {
    const streamed = useChatStore.getState().messages.find((m) => m.id === streamingId);
    useChatStore.getState().updateMessage(streamingId, { content: streamed?.content?.trim() ? streamed.content : (finalText ?? streamed?.content ?? ''), streaming: false });
  } else if (finalText) {
    // Defensive fallback: a run may complete with finalText even if the live
    // text_delta/provider.response path failed to create a visible assistant
    // bubble. Preserve the user-facing reply so next steps can render.
    useChatStore.getState().addMessage({ role: 'assistant', content: finalText });
  }
  useChatStore.getState().setCurrentAssistantMessage(null);
  useChatStore.getState().clearThinking();
  const runStart = useChatStore.getState().runStart;
  if (runStart && payload.status === 'done') {
    const all = useChatStore.getState().messages;
    let lastAssistantIdx = -1;
    let toolCount = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = expectDefined(all[i]);
      if (m.role === 'assistant' && lastAssistantIdx === -1 && m.content) lastAssistantIdx = i;
      if (m.role === 'tool' && m.timestamp >= runStart.at) toolCount += 1;
      if (m.role === 'user' && m.timestamp <= runStart.at) break;
    }
    if (lastAssistantIdx !== -1) {
      const sessionCost = useSessionStore.getState().cost;
      useChatStore.getState().updateMessage(all[lastAssistantIdx]?.id, { runSummary: { iterations, tools: toolCount, durationMs: Date.now() - runStart.at, costDelta: Math.max(0, sessionCost - runStart.cost) } });
    }
  }
  useChatStore.getState().setRunStart(null);
  if (payload.status !== 'done' && payload.error) {
    useChatStore.getState().addMessage({ role: 'assistant', content: `Error: ${payload.error.message}`, isError: true });
    toast.error(`Run ended: ${payload.error.message}`);
    notifyIfHidden(`${useSessionStore.getState().projectName || 'Agent'} run failed`, payload.error.message);
    if (typeof document !== 'undefined' && document.hidden) setFaviconStatus('error');
  } else if (payload.status === 'done') {
    if (typeof document !== 'undefined' && document.hidden) {
      toast.success(`Run completed in ${iterations} iteration${iterations === 1 ? '' : 's'}`);
      notifyIfHidden(`${useSessionStore.getState().projectName || 'Agent'} run finished`, `Completed in ${iterations} iteration${iterations === 1 ? '' : 's'}.`);
      setFaviconStatus('ready');
    }
    void ensureNotificationPermission();
    if (useConfigStore.getState().soundOnComplete) {
      try { playCompletionChime(); } catch { /* audio policy */ }
    }
  }
  const next = useChatStore.getState().dequeue();
  if (next) {
    const client = getWSClient(useConfigStore.getState().wsUrl);
    useChatStore.getState().addMessage({ role: 'user', content: next.text });
    useChatStore.getState().setLoading(true);
    client.sendMessage(next.text);
  }
}
