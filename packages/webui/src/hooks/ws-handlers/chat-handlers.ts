import { projectNextStepsToolInput } from '@wrongstack/tools/next-steps';
import { projectChatMessage, projectToolMessage } from '@wrongstack/webui-protocol';
import { presentArtifactResult } from '@/lib/artifact-presentation';
import { playPermissionChime } from '@/lib/chime';
import { setFaviconStatus } from '@/lib/favicon';
import { ensureNotificationPermission, notifyIfHidden } from '@/lib/notify';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { getWSClient } from '@/lib/ws-client';
import { chatFor, pipeViz, safePayload, sessionFor } from '@/lib/ws-client-utils';
import { useConfigStore, useSessionStore, useSessionTabStore, useUIStore } from '@/stores';
import { resolvePendingConfirm } from '@/stores/chat-lanes';
import { sessionPref } from '@/stores/local-prefs';
import { useToolStatsStore } from '@/stores/tool-stats-store';
import type { WSServerMessage } from '@/types';
import { handleRunResult } from './chat-run-result.js';
import {
  completedToolNextSteps,
  isForeground,
  laneNextSteps,
  nextStepsByToolId,
  thinkingKey,
} from './chat-run-state.js';

export { handleRunResult, isAutoContinuableRunError } from './chat-run-result.js';
export { forgetLaneRunState } from './chat-run-state.js';

/**
 * Agent attribution from the raw wire payload (`projectToolMessage` drops it).
 * Present when a subagent/peer agent made the call inside this session — the
 * agent-to-agent slice of the tool stats.
 */
function wireAgentName(msg: WSServerMessage): string | undefined {
  const p = msg.payload as { agentName?: string | undefined } | undefined;
  return typeof p?.agentName === 'string' && p.agentName.length > 0 ? p.agentName : undefined;
}

export const chatHandlerMap: Partial<Record<string, (msg: WSServerMessage) => void>> = {
  'iteration.started': handleIterationStarted,
  'provider.text_delta': handleTextDelta,
  'provider.thinking_delta': handleThinkingDelta,
  // Token metering only. installHandlers (useWebSocket.ts) feeds every handled
  // type to observeStreamActivity before calling the handler; registering the
  // type here is what lets the stream meter see it. Nothing else to render.
  'provider.output_progress': () => {},
  'tool.started': handleToolStarted,
  'tool.progress': handleToolProgress,
  'tool.executed': handleToolExecuted,
  'tool.confirm_needed': handleToolConfirmNeeded,
  'tool.confirm_resolved': handleToolConfirmResolved,
  'run.result': handleRunResult,
  'session.run_state': handleSessionRunState,
};
export function handleIterationStarted(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  pipeViz(msg);
  if ((msg.payload as { index?: unknown }).index === 1) {
    nextStepsByToolId.delete(chat.sessionId);
    completedToolNextSteps.delete(chat.sessionId);
  }
  const payload = msg.payload as { index: number; maxIterations?: number | undefined };
  // Iteration and cost belong to the SESSION that is iterating, not to the tab
  // in front. Reading `useSessionStore` here is what made a background run
  // drive the foreground's iteration chip.
  const meta = sessionFor(msg);
  meta?.setIteration({ index: payload.index, max: payload.maxIterations ?? 0 });
  chat.setLoading(true);
  if (typeof document !== 'undefined' && document.hidden && isForeground(chat)) {
    setFaviconStatus('running');
  }
  if (chat.runStart === null) {
    chat.setRunStart({ at: Date.now(), cost: meta?.data.cost ?? 0 });
  }
  chat.setCurrentAssistantMessage(null);
}

export function handleTextDelta(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  // Per-token viz push removed — text_delta fires dozens of times per
  // assistant message during streaming, and a per-token viz-store update
  // has no visible effect on the cinematic view (it scrolls past faster
  // than any frame budget). Iteration/tool/run-result events still pipe
  // through, so viz reflects the structural shape of the run.
  const payload = projectChatMessage(msg);
  if (payload?.kind !== 'text-delta') return;
  streamCoalescer.flush(thinkingKey(chat.sessionId));
  chat.clearThinking();
  let id = chat.currentAssistantMessageId;
  if (!id) {
    id = chat.addMessage({ role: 'assistant', content: '', streaming: true });
    chat.setCurrentAssistantMessage(id);
  }
  streamCoalescer.push(
    id,
    payload.text,
    (mid, text) => chat.appendToMessage(mid, text),
    chat.sessionId,
  );
}

export function handleThinkingDelta(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  // Per-token viz push removed (same reasoning as handleTextDelta).
  const payload = projectChatMessage(msg);
  if (payload?.kind !== 'thinking-delta') return;
  streamCoalescer.push(
    thinkingKey(chat.sessionId),
    payload.text,
    (_k, text) => chat.appendThinking(text),
    chat.sessionId,
  );
}

export function handleToolStarted(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  pipeViz(msg);
  const payload = projectToolMessage(msg);
  if (payload?.kind !== 'started') return;
  if (payload.name === 'nextsteps' && payload.id) {
    laneNextSteps(chat.sessionId).set(payload.id, projectNextStepsToolInput(payload.input));
  }
  const existingId = chat.getToolMessageId(payload.id);
  if (existingId) {
    // A replay can arrive after completion; do not displace the active tool.
    const existing = chat.messages.find((message) => message.id === existingId);
    if (existing && existing.toolResult === undefined) chat.setCurrentToolId(existingId);
    return;
  }
  streamCoalescer.flushAll();
  chat.clearThinking();
  const assistantId = chat.currentAssistantMessageId;
  // A tool bubble follows, so this assistant text is mid-turn: strip its
  // <nextsteps> block but do not persist the steps.
  if (assistantId) chat.finalizeMessage(assistantId, { final: false });
  chat.setCurrentAssistantMessage(null);
  const id = chat.addMessage({
    role: 'tool',
    content: '',
    toolName: payload.name,
    toolInput: payload.input,
    toolUseId: payload.id,
  });
  chat.setCurrentToolId(id);
  chat.addExecution({
    id: payload.id,
    name: payload.name,
    input: payload.input,
    ok: true,
    startedAt: Date.now(),
  });
  // Mirrors addExecution's dedup: this line sits below the replayed-started
  // early return, so a reconnect replay cannot double-count a call.
  useToolStatsStore.getState().recordToolStarted(chat.sessionId, {
    name: payload.name,
    agentName: wireAgentName(msg),
  });
}

export function handleToolProgress(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const payload = projectToolMessage(msg);
  if (payload?.kind !== 'progress') return;
  const text = payload.text;
  if (!text) return;
  const ownerId = chat.getToolMessageId(payload.id);
  if (!ownerId) return;
  const prefix = payload.eventType === 'warning' ? '⚠ ' : '';
  streamCoalescer.push(
    ownerId,
    `${prefix}${text}\n`,
    (_oid, buffered) =>
      chat.appendToolProgressLinesByUseId(
        payload.id,
        buffered.split('\n').filter((l) => l.length > 0),
      ),
    chat.sessionId,
  );
}

export function handleToolExecuted(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  pipeViz(msg);
  const payload = projectToolMessage(msg);
  if (payload?.kind !== 'executed') return;
  presentArtifactResult(payload.name, payload.ok, payload.output, chat.sessionId);
  if (payload.name === 'nextsteps' && payload.id) {
    const lane = laneNextSteps(chat.sessionId);
    const steps = lane.get(payload.id) ?? [];
    lane.delete(payload.id);
    if (payload.ok && steps.length > 0) completedToolNextSteps.set(chat.sessionId, steps);
  }
  const { currentToolId } = chat;
  const ownerId = payload.id ? chat.getToolMessageId(payload.id) : currentToolId;
  if (ownerId) {
    streamCoalescer.drop(ownerId);
    if (payload.id) {
      chat.setToolResultByUseId(payload.id, payload.output ?? '', payload.ok);
    } else {
      chat.setToolResult(ownerId, payload.output ?? '', payload.ok);
    }
    chat.updateMessage(ownerId, {
      toolDurationMs: payload.durationMs,
      ...(payload.outputBytes !== undefined ? { toolOutputBytes: payload.outputBytes } : {}),
      ...(payload.outputTokens !== undefined ? { toolOutputTokens: payload.outputTokens } : {}),
      ...(payload.outputLines !== undefined ? { toolOutputLines: payload.outputLines } : {}),
      // SAGE memory arrives as its own field; keep it off `toolResult` so the
      // block can only ever render as a memory card.
      ...(payload.sage && payload.sage.length > 0 ? { sageLines: payload.sage } : {}),
    });
  }
  if (payload.id)
    chat.updateExecution(payload.id, {
      completedAt: Date.now(),
      durationMs: payload.durationMs,
      output: payload.output,
      ok: payload.ok,
    });
  useToolStatsStore.getState().recordToolExecuted(chat.sessionId, {
    name: payload.name,
    ok: payload.ok,
    durationMs: payload.durationMs,
    agentName: wireAgentName(msg),
  });
  if (currentToolId && ownerId === currentToolId) chat.setCurrentToolId(null);
}

export function handleToolConfirmNeeded(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const payload = msg.payload as {
    id: string;
    toolName: string;
    input: unknown;
    suggestedPattern: string;
    decisionSource?: string | undefined;
    riskTier?: 'safe' | 'standard' | 'destructive' | undefined;
    boundaryReason?: string | undefined;
    deadlineAt?: number | undefined;
    writeTargets?: string[] | undefined;
  };
  // YOLO belongs to the session that raised the prompt. Reading the flat
  // field asks the tab in FRONT, which auto-approved a background tab's tool
  // because a different tab happened to be in YOLO — an approval the user
  // never gave for that session.
  const destructive =
    payload.riskTier === 'destructive' || payload.decisionSource === 'yolo_destructive';
  if (sessionPref(chat.sessionId, 'yolo') === true && !payload.boundaryReason && !destructive) {
    getWSClient(useConfigStore.getState().wsUrl).sendConfirm(payload.id, 'yes');
    useUIStore.getState().hideConfirm();
    return;
  }
  if (!isForeground(chat)) {
    // A background tab's approval prompt must not open over the tab the user
    // is working in — a modal is the loudest possible cross-tab bleed. Park it
    // on that tab's lane and flag the tab; `session-tab-store.activate()`
    // opens it when the user switches there. Without the park the prompt was
    // discarded and the run sat blocked behind an attention dot with no way
    // to answer it.
    chat.setPendingConfirm(payload);
    useSessionTabStore.getState().setAttention(chat.sessionId, true);
    void ensureNotificationPermission();
    notifyIfHidden(
      `${useSessionStore.getState().projectName || 'Agent'} needs approval`,
      `Another tab is waiting on "${payload.toolName}".`,
      'agent-confirm',
    );
    return;
  }
  chat.setPendingConfirm(payload);
  useUIStore.getState().showConfirm({
    id: payload.id,
    toolName: payload.toolName,
    input: payload.input,
    suggestedPattern: payload.suggestedPattern,
    decisionSource: payload.decisionSource,
    riskTier: payload.riskTier,
    boundaryReason: payload.boundaryReason,
    deadlineAt: payload.deadlineAt,
    writeTargets: payload.writeTargets,
  });
  try {
    playPermissionChime();
  } catch {
    /* audio policy */
  }
  void ensureNotificationPermission();
  const label = useSessionStore.getState().projectName || 'Agent';
  notifyIfHidden(
    `${label} needs approval`,
    `Tool "${payload.toolName}" is waiting for your decision.`,
    'agent-confirm',
  );
  if (typeof document !== 'undefined' && document.hidden) setFaviconStatus('attention');
}

export function handleToolConfirmResolved(msg: WSServerMessage) {
  const payload = msg.payload as { id?: unknown };
  if (typeof payload.id !== 'string') return;
  resolvePendingConfirm(payload.id);
  const visible = useUIStore.getState().confirmInfo;
  if (visible?.id === payload.id) useUIStore.getState().hideConfirm();
}

/**
 * Reconcile one tab's spinner with the server's answer.
 *
 * Sent per declared tab in reply to `session.subscribe`, which the client
 * re-sends on every reconnect. `run.result` — the message that stops a lane
 * spinning — is broadcast exactly once, so a background tab whose run ended
 * while the socket was down had no way to learn about it: it span forever,
 * counted as busy, could not be recycled, and offered to abort a run that was
 * long finished. Positive routing as usual: an answer for a session with no
 * lane is dropped, never applied to the tab in front.
 *
 * On run-end this is a PARTIAL teardown only. The real reply finalization,
 * chime, queue drain and message bookkeeping still arrive in `run.result`;
 * the only fields that would otherwise drift across a reconnect gap are the
 * per-run scratch ones that have no meaning without the run. Clearing them
 * here stops the NEXT run from inheriting a stale `runStart` (which would
 * inflate its `durationMs`/`costDelta`) and lets the spinner + thinking-log
 * reset cleanly before the final `run.result` lands.
 */
export function handleSessionRunState(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const payload = safePayload<{ isRunning: boolean }>(msg, { isRunning: 'boolean' }, {});
  if (!payload) return;
  if (chat.isLoading === payload.isRunning) return;
  chat.setLoading(payload.isRunning);
  if (!payload.isRunning) {
    streamCoalescer.flushAll();
    chat.flushThinkingLog(1);
    const meta = sessionFor(msg);
    meta?.setIteration(null);
    chat.clearThinking();
    chat.setRunStart(null);
  }
}
