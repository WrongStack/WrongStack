import { expectDefined } from '@wrongstack/core/utils/expect-defined';
import { parseNextSteps, projectNextStepsToolInput } from '@wrongstack/tools/next-steps';
import { projectChatMessage, projectToolMessage } from '@wrongstack/webui-protocol';
import { toWireImages } from '@/components/ChatInput/image-attachments';
import { toast } from '@/components/Toaster';
import { playCompletionChime, playPermissionChime } from '@/lib/chime';
import { setFaviconStatus } from '@/lib/favicon';
import { ensureNotificationPermission, notifyIfHidden } from '@/lib/notify';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { getWSClient } from '@/lib/ws-client';
import { isActiveSessionMessage, pipeViz, safePayload } from '@/lib/ws-client-utils';
import { useChatStore, useConfigStore, useSessionStore, useUIStore } from '@/stores';
import type { QueuedItem } from '@/stores/chat-store';
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

const nextStepsByToolId = new Map<string, ReturnType<typeof projectNextStepsToolInput>>();
let completedToolNextSteps: ReturnType<typeof projectNextStepsToolInput> = [];

export function handleIterationStarted(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  pipeViz(msg);
  if ((msg.payload as { index?: unknown }).index === 1) {
    nextStepsByToolId.clear();
    completedToolNextSteps = [];
  }
  const payload = msg.payload as { index: number; maxIterations?: number | undefined };
  useSessionStore
    .getState()
    .setIteration({ index: payload.index, max: payload.maxIterations ?? 0 });
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
  const payload = projectChatMessage(msg);
  if (payload?.kind !== 'text-delta') return;
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
  const payload = projectChatMessage(msg);
  if (payload?.kind !== 'thinking-delta') return;
  streamCoalescer.push('__thinking__', payload.text, (_k, text) =>
    useChatStore.getState().appendThinking(text),
  );
}

export function handleToolStarted(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  pipeViz(msg);
  const payload = projectToolMessage(msg);
  if (payload?.kind !== 'started') return;
  if (payload.name === 'nextsteps' && payload.id) {
    nextStepsByToolId.set(payload.id, projectNextStepsToolInput(payload.input));
  }
  const existingId = useChatStore.getState().getToolMessageId(payload.id);
  if (existingId) {
    useChatStore.getState().setCurrentToolId(existingId);
    return;
  }
  streamCoalescer.flushAll();
  useChatStore.getState().clearThinking();
  const assistantId = useChatStore.getState().currentAssistantMessageId;
  // A tool bubble follows, so this assistant text is mid-turn: strip its
  // <nextsteps> block but do not persist the steps.
  if (assistantId) useChatStore.getState().finalizeMessage(assistantId, { final: false });
  useChatStore.getState().setCurrentAssistantMessage(null);
  const id = useChatStore.getState().addMessage({
    role: 'tool',
    content: '',
    toolName: payload.name,
    toolInput: payload.input,
    toolUseId: payload.id,
  });
  useChatStore.getState().setCurrentToolId(id);
  useChatStore.getState().addExecution({
    id: payload.id,
    name: payload.name,
    input: payload.input,
    ok: true,
    startedAt: Date.now(),
  });
}

export function handleToolProgress(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const payload = projectToolMessage(msg);
  if (payload?.kind !== 'progress') return;
  const text = payload.text;
  if (!text) return;
  const ownerId = useChatStore.getState().getToolMessageId(payload.id);
  if (!ownerId) return;
  const prefix = payload.eventType === 'warning' ? '⚠ ' : '';
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
  const payload = projectToolMessage(msg);
  if (payload?.kind !== 'executed') return;
  if (payload.name === 'nextsteps' && payload.id) {
    const steps = nextStepsByToolId.get(payload.id) ?? [];
    nextStepsByToolId.delete(payload.id);
    if (payload.ok && steps.length > 0) completedToolNextSteps = steps;
  }
  const { currentToolId } = useChatStore.getState();
  const ownerId = payload.id ? useChatStore.getState().getToolMessageId(payload.id) : currentToolId;
  if (ownerId) {
    streamCoalescer.drop(ownerId);
    if (payload.id) {
      useChatStore.getState().setToolResultByUseId(payload.id, payload.output ?? '', payload.ok);
    } else {
      useChatStore.getState().setToolResult(ownerId, payload.output ?? '', payload.ok);
    }
    useChatStore.getState().updateMessage(ownerId, {
      toolDurationMs: payload.durationMs,
      // SAGE memory arrives as its own field; keep it off `toolResult` so the
      // block can only ever render as a memory card.
      ...(payload.sage && payload.sage.length > 0 ? { sageLines: payload.sage } : {}),
    });
  }
  if (payload.id)
    useChatStore.getState().updateExecution(payload.id, {
      completedAt: Date.now(),
      durationMs: payload.durationMs,
      output: payload.output,
      ok: payload.ok,
    });
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
    boundaryReason?: string | undefined;
  };
  if (useLocalPrefs.getState().yolo === true && !payload.boundaryReason) {
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
    boundaryReason: payload.boundaryReason,
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

export function handleRunResult(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const payload = safePayload<{
    requestId?: string;
    status: string;
    iterations?: number;
    finalText?: string;
    error?: { code?: string; message: string; recoverable: boolean };
  }>(
    msg,
    { status: 'string' },
    {
      requestId: 'string',
      iterations: 'number',
      finalText: 'string',
      error: 'object',
    },
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
    useChatStore.getState().updateMessage(streamingId, {
      content: streamed?.content?.trim()
        ? streamed.content
        : (finalText ?? streamed?.content ?? ''),
    });
    // The run is over — this is the turn's final answer, so its suggestions
    // are the ones the user should see.
    useChatStore.getState().finalizeMessage(streamingId, { final: true });
  } else if (finalText) {
    // Defensive fallback: a run may complete with finalText even if the live
    // text_delta/provider.response path failed to create a visible assistant
    // bubble. provider.response normally finalized the reply first, though,
    // so compare against both the raw final text and its visible (nextsteps-
    // stripped) form before adding anything. Otherwise the same reply lands
    // twice, with the fallback copy still exposing the raw XML block.
    const runStart = useChatStore.getState().runStart;
    const visibleFinalText = parseNextSteps(finalText).stripped.trim();
    const messages = useChatStore.getState().messages;
    let lastRunAssistant: (typeof messages)[number] | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const candidate = messages[i];
      if (candidate?.role === 'assistant' && (!runStart || candidate.timestamp >= runStart.at)) {
        lastRunAssistant = candidate;
        break;
      }
    }
    const existingContent = lastRunAssistant?.content.trim();
    const hasSameFinalText =
      existingContent !== undefined &&
      (existingContent === finalText || existingContent === visibleFinalText);
    if (!hasSameFinalText) {
      const messageId = useChatStore
        .getState()
        .addMessage({ role: 'assistant', content: finalText });
      useChatStore.getState().finalizeMessage(messageId, { final: true });
    }
  }
  if (payload.status === 'done' && completedToolNextSteps.length > 0) {
    const hasRenderedSuggestions = useChatStore
      .getState()
      .messages.some(
        (message) => message.role === 'assistant' && (message.nextSteps?.steps.length ?? 0) > 0,
      );
    if (!hasRenderedSuggestions) {
      useChatStore.getState().addMessage({
        role: 'assistant',
        content: '',
        nextSteps: { steps: completedToolNextSteps },
      });
    }
    completedToolNextSteps = [];
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
      useChatStore.getState().updateMessage(all[lastAssistantIdx]?.id, {
        runSummary: {
          iterations,
          tools: toolCount,
          durationMs: Date.now() - runStart.at,
          costDelta: Math.max(0, sessionCost - runStart.cost),
        },
      });
    }
  }
  useChatStore.getState().setRunStart(null);
  if (payload.status !== 'done' && payload.error) {
    if (payload.requestId) {
      useChatStore.getState().updateMessage(payload.requestId, { status: 'failed' });
    }
    useChatStore
      .getState()
      .addMessage({ role: 'assistant', content: `Error: ${payload.error.message}`, isError: true });
    toast.error(`Run ended: ${payload.error.message}`);
    notifyIfHidden(
      `${useSessionStore.getState().projectName || 'Agent'} run failed`,
      payload.error.message,
    );
    if (typeof document !== 'undefined' && document.hidden) setFaviconStatus('error');
  } else if (payload.status === 'done') {
    if (typeof document !== 'undefined' && document.hidden) {
      toast.success(`Run completed in ${iterations} iteration${iterations === 1 ? '' : 's'}`);
      notifyIfHidden(
        `${useSessionStore.getState().projectName || 'Agent'} run finished`,
        `Completed in ${iterations} iteration${iterations === 1 ? '' : 's'}.`,
      );
      setFaviconStatus('ready');
    }
    void ensureNotificationPermission();
    if (useConfigStore.getState().soundOnComplete) {
      try {
        playCompletionChime();
      } catch {
        /* audio policy */
      }
    }
    // Signal NextStepsBar to start a timed auto-fill countdown that places
    // the first suggestion into the input without auto-submitting. The user
    // can still modify it or press Enter to send.
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('chat:next-step-countdown'));
    }
  }
  const store = useChatStore.getState();
  // ── Drain target selection ───────────────────────────────────────────
  // Peek at the front without popping. If the front is a BTW chip that
  // is already wire-sent (mid-way through its visible SENT grace window,
  // owned by `BTW_DISPATCH_GRACE_MS` / `dispatchedGraceTimers`), leave
  // it where it is — its visible lifecycle is owned by the grace timer,
  // not by `run.result`. Drain the first non-dispatched item.
  const front = store.queue[0];
  if (!front) return;
  if (front.alreadyDispatched === true) {
    // Add the user bubble for the dispatched chip so the transcript
    // stays complete — same intent as the pre-fix drain path. The
    // `bubbleAdded` flag gates idempotency: a second `run.result`
    // landing inside the grace window must NOT add a duplicate bubble.
    // The grace timer still owns the chip's removal from the queue.
    addBubbleFor(front);
    const drained = store.dequeueDrainable();
    if (!drained) return;
    return runDrain(drained);
  }
  // Front is a pending item — pop it and drain. Cancels any pending
  // grace timer for it (none should exist since `alreadyDispatched`
  // is false, but the cancel is idempotent and safe).
  const drained = store.dequeue();
  if (!drained) return;
  return runDrain(drained);
}

/**
 * Add a user message bubble for the drained item. Idempotent per chip:
 * once added, the chip's `bubbleAdded` flag prevents subsequent
 * `run.result` events inside the grace window from emitting a duplicate
 * bubble for the same chat note. The pre-fix path popped the chip
 * exactly once, so the bubble was emitted exactly once; the new
 * path keeps the chip in the queue for its visible lifecycle, so
 * the gate is the only thing preserving the "one bubble per chip"
 * invariant.
 *
 * Mirrors the wire-encoding of a regular user_message so the
 * bubble's `attachments` carry the same image chips a typed send
 * would produce.
 */
function addBubbleFor(next: QueuedItem): void {
  if (next.bubbleAdded === true) return;
  const images = next.images ?? [];
  useChatStore.getState().addMessage({
    role: 'user',
    content: next.text,
    ...(images.length > 0
      ? {
          attachments: images.map((img) => ({
            id: img.id,
            kind: 'image' as const,
            dataUrl: img.dataUrl,
            mediaType: img.mediaType,
            bytes: img.bytes,
            name: img.name,
          })),
        }
      : {}),
  });
  // Stamp the flag in-place so the next `run.result` skips the second
  // emit. We mutate the next object directly (the queue array holds
  // the same reference) which is safe because the queue is rebuilt
  // by `dequeue`/`dequeueDrainable` before its members are read.
  next.bubbleAdded = true;
}

/**
 * Drain a single queued item into the chat + wire.
 *
 * - 'btw' mode: the note rides alongside the running agent via the
 *   mailbox and is injected into context on the next iteration. If it
 *   was already dispatched at submit time (immediate mid-run mailbox
 *   injection in ChatInput.submitWith), re-sending would fold the same
 *   note into the agent's context a second time — skip the mailbox
 *   branch but still add the user bubble so the transcript stays
 *   complete.
 * - 'queue' / 'steer' (default): sends as a regular user_message,
 *   starting a fresh run after the current one finishes.
 */
function runDrain(next: QueuedItem): void {
  const client = getWSClient(useConfigStore.getState().wsUrl);
  const images = next.images ?? [];
  useChatStore.getState().addMessage({
    role: 'user',
    content: next.text,
    ...(images.length > 0
      ? {
          attachments: images.map((img) => ({
            id: img.id,
            kind: 'image' as const,
            dataUrl: img.dataUrl,
            mediaType: img.mediaType,
            bytes: img.bytes,
            name: img.name,
          })),
        }
      : {}),
  });

  // ── Mode-aware dispatch ──────────────────────────────────────────────
  if (next.mode === 'btw') {
    if (next.alreadyDispatched !== true) {
      client.sendMailboxMessage({
        type: 'btw',
        to: 'leader',
        subject: 'btw from WebUI',
        body: next.text,
        priority: 'normal',
        audience: 'all',
      });
    }
    // Don't set loading — we're not starting a run, the mailbox
    // injection will fold into the existing run's next iteration.
    return;
  }

  useChatStore.getState().setLoading(true);
  client.sendMessage(next.text, images.length > 0 ? toWireImages(images) : undefined);
}
