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
import { chatFor, pipeViz, safePayload, sessionFor } from '@/lib/ws-client-utils';
import { useConfigStore, useSessionStore, useSessionTabStore, useUIStore } from '@/stores';
import { activeLaneId, type ChatLaneActions, onLaneDisposed } from '@/stores/chat-lanes';
import type { QueuedItem } from '@/stores/chat-store';
import { sessionPref } from '@/stores/local-prefs';
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
  handleSessionRunState,
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
  'session.run_state': handleSessionRunState,
};

type NextSteps = ReturnType<typeof projectNextStepsToolInput>;

/**
 * Per-lane run bookkeeping. These used to be two module-level globals, which
 * meant tab 2's `nextsteps` tool output became tab 1's suggestion chips the
 * moment both were running. Everything scoped to a run is now keyed by the
 * session that owns the run.
 */
const nextStepsByToolId = new Map<string, Map<string, NextSteps>>();
const completedToolNextSteps = new Map<string, NextSteps>();

function laneNextSteps(sessionId: string): Map<string, NextSteps> {
  let map = nextStepsByToolId.get(sessionId);
  if (!map) {
    map = new Map();
    nextStepsByToolId.set(sessionId, map);
  }
  return map;
}

/** Coalescer key for a lane's thinking buffer. Shared keys merged two tabs'
 *  reasoning into one stream, so the key carries the session. */
function thinkingKey(sessionId: string): string {
  return `__thinking__:${sessionId}`;
}

/**
 * True when this lane is the one on screen. DOM-level side effects (the
 * composer's next-step countdown, the favicon) belong to the foreground only:
 * a background run finishing must not reach into the tab the user is typing in.
 */
function isForeground(chat: ChatLaneActions): boolean {
  return chat.sessionId === activeLaneId();
}

/**
 * How a tab is named in a desktop notification.
 *
 * A run that ends in a background tab is still worth telling the user about —
 * they may be in another app entirely — but a bare "run finished" over four
 * open conversations is a riddle. The nickname is what the tab strip shows, so
 * it is the label the user can actually match against.
 */
function tabLabel(sessionId: string): string {
  const nickname = useUIStore.getState().sessionNicknames[sessionId];
  return nickname ?? `session ${sessionId.slice(0, 8)}`;
}

/**
 * Run notifications are tagged PER SESSION.
 *
 * `notifyIfHidden` collapses same-tag notifications so a single run cannot
 * litter the notification centre — but with four tabs on one page that same
 * collapse silently swallowed three of four completions, and the one that
 * survived was whichever landed last. One tag per session keeps the collapse
 * within a conversation, which is what it was for.
 */
function runTag(sessionId: string): string {
  return `wrongstack-run:${sessionId}`;
}

/** Forget a retired lane's run bookkeeping. */
export function forgetLaneRunState(sessionId: string): void {
  nextStepsByToolId.delete(sessionId);
  completedToolNextSteps.delete(sessionId);
  streamCoalescer.drop(thinkingKey(sessionId));
}

// Closing a tab disposes its lane; these maps have to go with it. Exported and
// never called, they leaked a retired session's pending next-steps and its
// thinking buffer for the life of the page — and would have resurfaced them if
// the id were ever reused.
onLaneDisposed(forgetLaneRunState);

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
  streamCoalescer.push(id, payload.text, (mid, text) => chat.appendToMessage(mid, text));
}

export function handleThinkingDelta(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  // Per-token viz push removed (same reasoning as handleTextDelta).
  const payload = projectChatMessage(msg);
  if (payload?.kind !== 'thinking-delta') return;
  streamCoalescer.push(thinkingKey(chat.sessionId), payload.text, (_k, text) =>
    chat.appendThinking(text),
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
    chat.setCurrentToolId(existingId);
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
  streamCoalescer.push(ownerId, `${prefix}${text}\n`, (_oid, buffered) =>
    chat.appendToolProgressLinesByUseId(
      payload.id,
      buffered.split('\n').filter((l) => l.length > 0),
    ),
  );
}

export function handleToolExecuted(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  pipeViz(msg);
  const payload = projectToolMessage(msg);
  if (payload?.kind !== 'executed') return;
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
  };
  // YOLO belongs to the session that raised the prompt. Reading the flat
  // field asks the tab in FRONT, which auto-approved a background tab's tool
  // because a different tab happened to be in YOLO — an approval the user
  // never gave for that session.
  if (sessionPref(chat.sessionId, 'yolo') === true && !payload.boundaryReason) {
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

export function handleRunResult(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
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
  chat.flushThinkingLog(Math.max(1, iterations));
  const meta = sessionFor(msg);
  meta?.setIteration(null);
  chat.setLoading(false);
  // Finalize the streaming assistant message so the UI stops showing the
  // typing indicator. Previously the message stayed `streaming: true` even
  // after run.result, leaving a perpetual "typing…" bubble if no later
  // message superseded it.
  const streamingId = chat.currentAssistantMessageId;
  const finalText = payload.status === 'done' ? payload.finalText?.trim() : undefined;
  if (streamingId) {
    const streamed = chat.messages.find((m) => m.id === streamingId);
    chat.updateMessage(streamingId, {
      content: streamed?.content?.trim()
        ? streamed.content
        : (finalText ?? streamed?.content ?? ''),
    });
    // The run is over — this is the turn's final answer, so its suggestions
    // are the ones the user should see.
    chat.finalizeMessage(streamingId, { final: true });
  } else if (finalText) {
    // Defensive fallback: a run may complete with finalText even if the live
    // text_delta/provider.response path failed to create a visible assistant
    // bubble. provider.response normally finalized the reply first, though,
    // so compare against both the raw final text and its visible (nextsteps-
    // stripped) form before adding anything. Otherwise the same reply lands
    // twice, with the fallback copy still exposing the raw XML block.
    const runStart = chat.runStart;
    const visibleFinalText = parseNextSteps(finalText).stripped.trim();
    const messages = chat.messages;
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
      const messageId = chat.addMessage({ role: 'assistant', content: finalText });
      chat.finalizeMessage(messageId, { final: true });
    }
  }
  const laneNextStepSuggestions = completedToolNextSteps.get(chat.sessionId) ?? [];
  if (payload.status === 'done' && laneNextStepSuggestions.length > 0) {
    const hasRenderedSuggestions = chat.messages.some(
      (message) => message.role === 'assistant' && (message.nextSteps?.steps.length ?? 0) > 0,
    );
    if (!hasRenderedSuggestions) {
      chat.addMessage({
        role: 'assistant',
        content: '',
        nextSteps: { steps: laneNextStepSuggestions },
      });
    }
    completedToolNextSteps.delete(chat.sessionId);
  }
  chat.setCurrentAssistantMessage(null);
  chat.clearThinking();
  const runStart = chat.runStart;
  if (runStart && payload.status === 'done') {
    const all = chat.messages;
    let lastAssistantIdx = -1;
    let toolCount = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = expectDefined(all[i]);
      if (m.role === 'assistant' && lastAssistantIdx === -1 && m.content) lastAssistantIdx = i;
      if (m.role === 'tool' && m.timestamp >= runStart.at) toolCount += 1;
      if (m.role === 'user' && m.timestamp <= runStart.at) break;
    }
    if (lastAssistantIdx !== -1) {
      const sessionCost = meta?.data.cost ?? 0;
      chat.updateMessage(all[lastAssistantIdx]?.id, {
        runSummary: {
          iterations,
          tools: toolCount,
          durationMs: Date.now() - runStart.at,
          costDelta: Math.max(0, sessionCost - runStart.cost),
        },
      });
    }
  }
  chat.setRunStart(null);
  if (payload.status !== 'done' && payload.error) {
    if (payload.requestId) {
      chat.updateMessage(payload.requestId, { status: 'failed' });
    }
    chat.addMessage({
      role: 'assistant',
      content: `Error: ${payload.error.message}`,
      isError: true,
    });
    const isSilentAbort =
      payload.error.message === 'User aborted' || payload.error.message === 'aborted';
    const foreground = isForeground(chat);
    if (!isSilentAbort) {
      // A toast is a foreground interruption with no room to say WHICH
      // conversation failed, so a background tab's failure reads as this
      // tab's. Its own transcript already carries the error bubble; the strip
      // carries the flag.
      if (foreground) toast.error(`Run ended: ${payload.error.message}`);
      else useSessionTabStore.getState().setAttention(chat.sessionId, true);
    }
    notifyIfHidden(
      foreground
        ? `${useSessionStore.getState().projectName || 'Agent'} run failed`
        : `${tabLabel(chat.sessionId)} run failed`,
      payload.error.message,
      runTag(chat.sessionId),
    );
    if (typeof document !== 'undefined' && document.hidden && isForeground(chat)) {
      setFaviconStatus('error');
    }
  } else if (payload.status === 'done') {
    if (typeof document !== 'undefined' && document.hidden) {
      const foreground = isForeground(chat);
      // The toast is queued while the page is hidden and surfaces when the
      // user comes back — in whatever tab is in front by then, which is not
      // necessarily the one that finished.
      if (foreground) {
        toast.success(`Run completed in ${iterations} iteration${iterations === 1 ? '' : 's'}`);
      } else {
        useSessionTabStore.getState().setAttention(chat.sessionId, true);
      }
      notifyIfHidden(
        foreground
          ? `${useSessionStore.getState().projectName || 'Agent'} run finished`
          : `${tabLabel(chat.sessionId)} run finished`,
        `Completed in ${iterations} iteration${iterations === 1 ? '' : 's'}.`,
        runTag(chat.sessionId),
      );
      if (foreground) setFaviconStatus('ready');
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
    if (typeof document !== 'undefined' && isForeground(chat)) {
      document.dispatchEvent(new CustomEvent('chat:next-step-countdown'));
    }
  }
  const store = chat;
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
    addBubbleFor(chat, front);
    const drained = store.dequeueDrainable();
    if (!drained) return;
    return runDrain(chat, drained);
  }
  // Front is a pending item — pop it and drain. Cancels any pending
  // grace timer for it (none should exist since `alreadyDispatched`
  // is false, but the cancel is idempotent and safe).
  const drained = store.dequeue();
  if (!drained) return;
  return runDrain(chat, drained);
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
function addBubbleFor(chat: ChatLaneActions, next: QueuedItem): void {
  if (next.bubbleAdded === true) return;
  const images = next.images ?? [];
  chat.addMessage({
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
function runDrain(chat: ChatLaneActions, next: QueuedItem): void {
  const client = getWSClient(useConfigStore.getState().wsUrl);
  const images = next.images ?? [];
  chat.addMessage({
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
      client.sendMailboxMessage(
        {
          type: 'btw',
          to: 'leader',
          subject: 'btw from WebUI',
          body: next.text,
          priority: 'normal',
          audience: 'all',
        },
        chat.sessionId,
      );
    }
    // Don't set loading — we're not starting a run, the mailbox
    // injection will fold into the existing run's next iteration.
    return;
  }

  chat.setLoading(true);
  // Address the send at the lane that owns the queue, NOT the tab in front:
  // a background run finishing drains ITS queue, and the default stamping
  // would have started that run in whichever session the user was looking at.
  client.sendMessage(
    next.text,
    images.length > 0 ? toWireImages(images) : undefined,
    false,
    chat.sessionId,
  );
}
