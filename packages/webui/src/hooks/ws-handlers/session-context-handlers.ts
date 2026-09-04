import { toast } from '@/components/Toaster';
import { i18n } from '@/i18n';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { getWSClient } from '@/lib/ws-client';
import {
  chatFor,
  isActiveSessionMessage,
  messageSessionId,
  pipeViz,
  sessionFor,
} from '@/lib/ws-client-utils';
import { useConfigStore, useSessionTabStore } from '@/stores';
import { activeChatLane, activeLaneId, type ChatLaneActions } from '@/stores/chat-lanes';
import { useResumeProgressStore } from '@/stores/resume-progress-store';
import { readSessionLane, setSessionGlobals } from '@/stores/session-lanes';
import type { WSServerMessage, WSUserMessageImage } from '@/types';

/**
 * Models this conversation has already warned about, per conversation.
 *
 * One shared Set meant the first tab to hit an unpriced model silenced the
 * warning for the other three — a tab's run reaching into process-wide state
 * and changing what a different tab is told.
 */
export const warnedCostModels = new Map<string, Set<string>>();

/** Warned-model set for one conversation, created on first use. */
function warnedModelsFor(sessionId: string | null): Set<string> {
  const key = sessionId ?? '__unbound__';
  const existing = warnedCostModels.get(key);
  if (existing) return existing;
  const created = new Set<string>();
  warnedCostModels.set(key, created);
  return created;
}

/**
 * Land the reasoning buffered for ONE lane's current iteration.
 *
 * Defaults to the lane in front, which is the only lane an untagged
 * (deliberately fail-open) `error` event can legitimately be about.
 */
export function flushThinkingLogForCurrentIteration(
  lane: ChatLaneActions = activeChatLane(),
): void {
  streamCoalescer.flush(`__thinking__:${lane.sessionId}`);
  const current = readSessionLane(lane.sessionId).iteration;
  lane.flushThinkingLog(Math.max(1, current?.index ?? 1));
  lane.clearThinking();
}

export function handleContextDebug(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  const p = msg.payload as {
    total: number;
    systemPrompt: number;
    tools: { total: number; count: number; breakdown: Array<{ name: string; tokens: number }> };
    messages: {
      total: number;
      count: number;
      breakdown: Array<{ index: number; role: string; tokens: number; preview: string }>;
    };
  };
  const fmt = (n: number) => n.toLocaleString();
  const topTools = [...p.tools.breakdown].sort((a, b) => b.tokens - a.tokens).slice(0, 8);
  const topMsgs = [...p.messages.breakdown].sort((a, b) => b.tokens - a.tokens).slice(0, 8);
  chat.addMessage({
    role: 'assistant',
    content: [
      `📊 **Context breakdown** (heuristic — 4 chars/token)`,
      '',
      `**Total estimate:** ${fmt(p.total)} tokens`,
      `• System prompt: ${fmt(p.systemPrompt)}`,
      `• Tool schemas: ${fmt(p.tools.total)} (${p.tools.count} tools)`,
      `• Messages: ${fmt(p.messages.total)} (${p.messages.count} messages)`,
      '',
      `**Top tool schemas:**`,
      ...topTools.map((t) => `  · ${t.name}: ${fmt(t.tokens)}`),
      '',
      `**Top messages:**`,
      ...topMsgs.map(
        (m) => `  · #${m.index} ${m.role}: ${fmt(m.tokens)} — ${m.preview || '(empty)'}`,
      ),
    ].join('\n'),
  });
}

/**
 * The server's general-purpose "did that work?" reply.
 *
 * Two things were wrong here, and both are about a socket that serves up to
 * four tabs:
 *
 *  1. The toast was unconditional. A background tab's "commit failed" or
 *     "provider key rejected" popped on whichever tab the user was looking at,
 *     with no way to tell whose it was — and the tab that actually failed
 *     showed nothing at all when switched to. The server now stamps the asking
 *     tab (`sessionId`, see B-05), so the toast fires only for the tab in
 *     front and a background tab gets an attention marker on its tab strip
 *     instead — the same treatment `provider.fallback_pending` already gives.
 *  2. EVERY result re-fetched the saved-provider list, including a prefs
 *     validation error that has nothing to do with providers. The refetch is
 *     kept (deciding from the message PROSE which results touch providers
 *     would be a worse bug than the extra round trip) but it now runs only on
 *     the foreground path, so a background tab's result no longer triggers it
 *     at all.
 */
export function handleKeyOperationResult(msg: WSServerMessage) {
  const p = msg.payload as { success: boolean; message: string };
  if (!p || typeof p.message !== 'string') return;
  // Session transitions / tab switches must be silent without popup toast noise
  if (
    p.message.startsWith('Resumed session') ||
    p.message.includes('Session is already active') ||
    p.message.startsWith('Swapped session')
  ) {
    return;
  }
  // An unstamped result (raised by a watcher or timer, with no asking tab)
  // keeps the old behaviour and lands on the tab in front.
  const owner = messageSessionId(msg);
  if (owner && owner !== activeLaneId()) {
    // Only a failure is worth pulling the user to another tab for; a silent
    // success there is exactly what "it worked" should look like.
    if (!p.success) useSessionTabStore.getState().setAttention(owner, true);
    return;
  }
  if (p.success) toast.success(p.message);
  else toast.error(p.message);
  const client = getWSClient(useConfigStore.getState().wsUrl);
  client.listSavedProviders();
}

/**
 * A successful model switch is broadcast to every surface, so it has to be
 * applied to the tab that ASKED for it. Applying it to whatever session was in
 * front is why switching the model in tab 2 re-labelled tab 1. It now
 * addresses the named lane; only the foreground's provider/model pickers,
 * which describe the tab on screen, follow along.
 */
export function handleModelSwitchResult(msg: WSServerMessage) {
  const p = msg.payload as {
    success: boolean;
    provider?: string | undefined;
    model?: string | undefined;
    previousProvider?: string | undefined;
    previousModel?: string | undefined;
    runActive: boolean;
  };
  if (!p.success || !p.provider || !p.model) return;

  const chat = chatFor(msg);
  const meta = sessionFor(msg);
  if (!chat || !meta) return;

  const laneSession = meta.data.session;
  meta.setSession({
    id: laneSession?.id ?? chat.sessionId,
    startedAt: laneSession?.startedAt ?? Date.now(),
    provider: p.provider,
    model: p.model,
    ...(laneSession?.title ? { title: laneSession.title } : {}),
  });

  if (chat.sessionId === activeLaneId()) {
    useConfigStore.getState().setProvider(p.provider);
    useConfigStore.getState().setModel(p.model);
  }

  const from =
    p.previousProvider && p.previousModel
      ? `${p.previousProvider} / ${p.previousModel}`
      : i18n.t('settings:toast.previousModel');
  const to = `${p.provider} / ${p.model}`;
  chat.addMessage({
    role: 'system',
    content: i18n.t(
      p.runActive
        ? 'settings:toast.modelSwitchedRunActive'
        : 'settings:toast.modelSwitchedNextRequest',
      { from, to },
    ),
  });
}

export function handleContextCompacted(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  pipeViz(msg);
  const payload = msg.payload as {
    before: number;
    after: number;
    saved: number;
    reductions: Array<{ phase: string; saved: number }>;
    repaired?: {
      removedToolUses: string[] | undefined;
      removedToolResults: string[];
      removedMessages: number;
    };
  };
  let summary = payload.reductions.length
    ? payload.reductions.map((r) => `${r.phase}: ${r.saved}`).join(', ')
    : 'no-op';
  if (payload.repaired)
    summary += `; repaired ${payload.repaired.removedToolUses?.length ?? 0} tool_use, ${payload.repaired.removedToolResults?.length ?? 0} tool_result, ${payload.repaired.removedMessages} empty messages`;
  chat.addMessage({
    role: 'system',
    content: `🗜️ Context compacted: ${payload.before} → ${payload.after} tokens (saved ~${payload.saved}). ${summary}`,
  });
  // The post-compaction size belongs to the compacted session's own context
  // bar, not to the tab in front.
  sessionFor(msg)?.patch({ lastInputTokens: payload.after });
}

export function handleCompactionFailed(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  pipeViz(msg);
  const payload = msg.payload as {
    message: string;
    level: string;
    tokens: number;
    maxContext: number;
    fatal: boolean;
    budget?: { inputTokens: number; availableInputTokens: number; load: number };
  };
  let load: number;
  let label: string;
  if (payload.budget && payload.budget.availableInputTokens > 0) {
    load = Math.min(100, Math.max(0, Math.round(payload.budget.load * 100)));
    label = 'input budget';
  } else {
    load =
      payload.maxContext > 0
        ? Math.min(100, Math.max(0, Math.round((payload.tokens / payload.maxContext) * 100)))
        : 0;
    label = 'context';
  }
  chat.addMessage({
    role: 'assistant',
    content: `Compaction failed at ${payload.level} (${load}% ${label}): ${payload.message}`,
    isError: payload.fatal,
  });
  if (chat.sessionId === activeLaneId()) toast.error(`Compaction failed: ${payload.message}`);
}

export function handleTrustPersisted(msg: WSServerMessage) {
  // Toast only, and a toast belongs to the tab on screen — tool trust itself
  // is a project-wide decision, so there is no per-tab record to keep here.
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as { tool: string; pattern: string; decision: 'always' | 'deny' };
  const label = `${p.tool}: ${p.pattern}`;
  if (p.decision === 'always') toast.success(`Always allowed ${label}`);
  else toast.warn(`Denied ${label}`);
}

export function handleContextRepaired(msg: WSServerMessage) {
  const chat = chatFor(msg);
  if (!chat) return;
  pipeViz(msg);
  const payload = msg.payload as {
    removedToolUses: string[];
    removedToolResults: string[];
    removedMessages: number;
    beforeMessages?: number | undefined;
    afterMessages?: number | undefined;
  };
  const removed =
    payload.removedToolUses.length + payload.removedToolResults.length + payload.removedMessages;
  const msgCount =
    payload.beforeMessages !== undefined && payload.afterMessages !== undefined
      ? ` Messages: ${payload.beforeMessages} -> ${payload.afterMessages}.`
      : '';
  chat.addMessage({
    role: 'assistant',
    content: `Context repaired: removed ${removed} orphan protocol item(s).${msgCount} tool_use ${payload.removedToolUses.length}, tool_result ${payload.removedToolResults.length}.`,
  });
}

export function handleContextPct(msg: WSServerMessage) {
  const meta = sessionFor(msg);
  if (!meta) return;
  pipeViz(msg);
  const p = msg.payload as { load: number; tokens: number; maxContext: number };
  meta.setContextUsage(p.tokens, p.maxContext);
}

export function handleContextMaxContext(msg: WSServerMessage) {
  const meta = sessionFor(msg);
  if (!meta) return;
  const p = msg.payload as {
    providerId?: string | undefined;
    modelId?: string | undefined;
    maxContext: number;
    previousMaxContext?: number | undefined;
    source?: 'configured' | 'provider' | 'provider_overflow' | undefined;
    decreased?: boolean | undefined;
  };
  meta.setEnvRates({ maxContext: p.maxContext });
  const lane = meta.data;
  if (
    p.source === 'provider' &&
    p.decreased === true &&
    typeof p.previousMaxContext === 'number' &&
    p.previousMaxContext > p.maxContext
  ) {
    meta.setContextLimitWarning({
      previousMaxContext: p.previousMaxContext,
      maxContext: p.maxContext,
      providerId: p.providerId ?? lane.session?.provider ?? 'provider',
      modelId: p.modelId ?? lane.session?.model ?? 'model',
    });
  } else if (p.decreased === false || p.source === 'configured') {
    meta.setContextLimitWarning(null);
  }
}

export function handleTokenThreshold(msg: WSServerMessage) {
  const meta = sessionFor(msg);
  if (!meta) return;
  const p = msg.payload as { used: number; limit: number };
  meta.setContextUsage(p.used, p.limit);
  const pct = p.limit > 0 ? Math.round((p.used / p.limit) * 100) : 0;
  if (meta.sessionId === activeLaneId()) toast.warn(`Token threshold reached (${pct}%)`);
}

export function handleTokenCostEstimateUnavailable(msg: WSServerMessage) {
  const sessionId = messageSessionId(msg);
  const p = msg.payload as { model: string };
  const model = p.model || '<unknown>';
  const warned = warnedModelsFor(sessionId);
  if (warned.has(model)) return;
  warned.add(model);
  // The toast is a foreground surface; a background tab records that it has
  // warned (so it does not shout on arrival) without stealing the screen.
  if (!sessionId || sessionId === activeLaneId()) {
    toast.warn(`Cost estimate unavailable for ${model}`);
  }
}

export function handleContextModesList(msg: WSServerMessage) {
  // The catalogue write is project-wide and the active id is addressed below,
  // so nothing here needed a foreground gate — it only threw away the reply a
  // background tab had asked for, leaving its context-mode picker empty.
  const p = msg.payload as {
    activeId: string;
    modes: Array<{
      id: string;
      name: string;
      description: string;
      isActive: boolean;
      thresholds?: { warn: number | undefined; soft: number; hard: number };
      preserveK?: number | undefined;
      eliseThreshold?: number | undefined;
      custom?: boolean | undefined;
    }>;
  };
  // The catalog is project-wide; which one is active is per-tab.
  setSessionGlobals({
    contextModes: p.modes.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      thresholds: m.thresholds,
      preserveK: m.preserveK,
      eliseThreshold: m.eliseThreshold,
      custom: m.custom,
    })),
  });
  (sessionFor(msg) ?? null)?.setEnvRates({ contextMode: p.activeId });
}

export function handleContextModeChanged(msg: WSServerMessage) {
  const meta = sessionFor(msg);
  if (!meta) return;
  const p = msg.payload as { id: string; name?: string | undefined };
  meta.setEnvRates({ contextMode: p.id });
}

export function handleSessionResumeProgress(msg: WSServerMessage) {
  const payload = msg.payload as {
    sessionId?: unknown;
    stage?: unknown;
    loadedBytes?: unknown;
    totalBytes?: unknown;
  };
  if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) return;
  useResumeProgressStore.getState().update(payload.sessionId, {
    stage: typeof payload.stage === 'string' ? payload.stage : 'open_journal',
    loadedBytes: typeof payload.loadedBytes === 'number' ? payload.loadedBytes : 0,
    totalBytes: typeof payload.totalBytes === 'number' ? payload.totalBytes : 0,
  });
}

export function handleError(msg: WSServerMessage) {
  const payload = msg.payload as {
    phase: string;
    message: string;
    requestedSessionId?: unknown;
    code?: unknown;
    content?: unknown;
    freshContext?: unknown;
    images?: unknown;
  };
  // A refused resume is still an answer: the tab it named stops waiting for a
  // transcript that is not coming. Done before the routing-noise swallow
  // below, because the swap-guard rejection IS one of the refusals a resume
  // can get back, and swallowing it silently would leave the pane loading
  // until the five-minute ceiling.
  if (payload.phase === 'session.resume' || payload.phase === 'session.focus') {
    const target =
      typeof payload.requestedSessionId === 'string'
        ? payload.requestedSessionId
        : messageSessionId(msg);
    if (target) useResumeProgressStore.getState().end(target);
  }
  if (payload.phase === 'todos.get') return;
  // Session-swap guard rejections — "Request targeted session X, but this
  // WebUI runtime is currently on Y" — are routing noise, not run failures:
  // the request never executed, so no run ended and nothing needs unblocking.
  // The server tags them with the session in FRONT, so delivering one here
  // dropped a bubble into whatever chat was visible (mid-stream, on every tab
  // switch) and cleared THAT lane's loading flag. The client's own swap state
  // is already unwound in ws-client.handleMessage; swallow the frame.
  if (typeof payload.requestedSessionId === 'string') return;
  // `session_not_ready` — the placeholder-writer refusal for a message sent
  // to a session that is not open in the runtime yet (the F5-restored-tab
  // case). The refusal echoes the original message, so ONE automatic retry
  // is possible: arm it, resume the session, and the session's
  // `session.start` replay fires the resend (ws-client `consumeArmedResend`).
  // The arm call is the one-shot guard — while it is on cooldown it returns
  // false and this frame degrades to the ordinary error bubble below
  // instead of a resume→refuse loop.
  if (payload.code === 'session_not_ready') {
    const sessionId = messageSessionId(msg);
    const content = typeof payload.content === 'string' ? payload.content : '';
    if (sessionId && content) {
      const images = Array.isArray(payload.images)
        ? (payload.images as WSUserMessageImage[])
        : undefined;
      const client = getWSClient();
      if (
        client.armNotReadyResend(sessionId, {
          content,
          freshContext: payload.freshContext === true,
          ...(images ? { images } : {}),
        })
      ) {
        client.resumeSession(sessionId);
        // Say what is happening instead of bubbling an error for a failure
        // the client is about to fix. The refused message never started a
        // run, so the lane's run flag comes down.
        const retryLane = chatFor(msg);
        retryLane?.addMessage({
          role: 'assistant',
          content: 'ℹ️ Session is reopening — your message will be resent automatically.',
        });
        retryLane?.setLoading(false);
        return;
      }
    }
  }
  // Routed by session, NEVER gated on "is this the tab in front".
  //
  // This handler owns per-lane state — the error bubble and, critically,
  // `setLoading(false)`. Dropping a BACKGROUND tab's error (which the
  // foreground gate here used to do) left that lane's run flag stuck true
  // forever with nothing on screen to explain it: the tab reported itself busy,
  // refused to close without the "stop and close" prompt, and never showed the
  // failure that actually ended its run — "Agent is already processing a
  // request" among them.
  //
  // `error` stays fail-OPEN — protocol and validation errors legitimately
  // carry no sessionId — so an untagged one lands on the lane in front.
  const chat = chatFor(msg) ?? activeChatLane();
  flushThinkingLogForCurrentIteration(chat);
  chat.addMessage({
    role: 'assistant',
    content: `[${payload.phase}] ${payload.message}`,
    isError: true,
  });
  chat.setLoading(false);
}
