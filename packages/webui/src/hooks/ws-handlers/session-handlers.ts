import type { SessionMarker } from '@wrongstack/core/types';
import { isFinalTurnStopReason } from '@wrongstack/tools/next-steps';
import { toast } from '@/components/Toaster';
import { isMobileViewport } from '@/hooks/useViewport';
import { reconcileFileTabsAfterEnvChange } from '@/hooks/ws-handlers/files-mailbox-handlers';
import { i18n } from '@/i18n';
import { isDesktopShell } from '@/lib/desktop-shell';
import { setFaviconStatus } from '@/lib/favicon';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { navigateToView, showPanel } from '@/lib/view-navigation';
import { getWSClient } from '@/lib/ws-client';
import { isActiveSessionMessage, pipeViz } from '@/lib/ws-client-utils';
import type { ChatMessage, SessionHistoryEntry, SubagentView } from '@/stores';
import {
  resetUiNavigationToHome,
  useChatStore,
  useConfigStore,
  useFallbackStore,
  useFileStore,
  useFleetStore,
  useHistoryStore,
  useProviderStatusStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import { useMemoryInjectorTraceStore } from '@/stores/memory-injector-store';
import { useVizStore, wsToVizEvent } from '@/stores/viz-store';
import type { WSServerMessage } from '@/types';

interface ReplayMessage {
  role: string | undefined;
  content: unknown;
  ts?: string | undefined;
}

function replayTimestamp(ts: string | undefined): number {
  if (typeof ts !== 'string') return Date.now();
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function replayMessageId(index: number): string {
  return `replay_${Date.now()}_${index}`;
}

function isRoutePinnedView(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location.pathname === '/debug' ||
    window.location.pathname === '/analytics' ||
    window.location.pathname === '/refresh-debug'
  );
}

function contentToToolResult(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function providerResponseText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n');
}

/**
 * Keep provider/model objects from crossing the WebSocket trust boundary into
 * persisted Zustand state. Legacy provider instances expose a public id/name;
 * never stringify the full object because it may also contain credentials.
 */
function sessionRouteIdentifier(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';

  const record = value as Record<string, unknown>;
  for (const key of ['id', 'name', 'type'] as const) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function hydrateReplayMessages(
  replay: ReplayMessage[],
  markers: readonly SessionMarker[] = [],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const toolMessagesByUseId = new Map<string, ChatMessage>();
  let thinkingLogIteration = 0;
  let markerIndex = 0;

  const pushText = (role: 'user' | 'assistant' | 'system', content: string, timestamp: number) => {
    if (!content) return;
    messages.push({ id: replayMessageId(messages.length), role, content, timestamp });
  };
  const pushMarker = (marker: SessionMarker) => {
    messages.push({
      id: replayMessageId(messages.length),
      role: 'system',
      content: marker.text,
      timestamp: replayTimestamp(marker.ts),
      isError: marker.level === 'error' ? true : undefined,
    });
  };
  /**
   * Emit every marker that happened strictly before `boundary`.
   *
   * Interleaving happens during the walk rather than as a merge pass
   * afterwards, because `replayTimestamp` substitutes `Date.now()` for a
   * message with no `ts` — merging on those synthesized values would sort
   * every timestamp-less message behind the markers. Here the real `ts` is
   * still in hand, so an unknown one simply doesn't advance the marker
   * cursor. Ties keep the message first, matching the TUI's merge rule.
   */
  const flushMarkersBefore = (boundary: string | undefined) => {
    if (typeof boundary !== 'string') return;
    while (markerIndex < markers.length && markers[markerIndex]!.ts < boundary) {
      pushMarker(markers[markerIndex]!);
      markerIndex += 1;
    }
  };
  const pushThinkingLog = (text: string, timestamp: number) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    thinkingLogIteration += 1;
    messages.push({
      id: replayMessageId(messages.length),
      role: 'system',
      content: '',
      timestamp,
      thinkingLog: {
        iteration: thinkingLogIteration,
        text: trimmed,
        startedAt: timestamp,
        durationMs: 0,
        replayed: true,
      },
    });
  };

  for (const m of replay) {
    flushMarkersBefore(m.ts);
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;
    const role = m.role;
    const timestamp = replayTimestamp(m.ts);
    if (typeof m.content === 'string') {
      pushText(role, m.content, timestamp);
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    let text = '';
    const thinking: string[] = [];
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        thinking.push(block.thinking);
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        text += (text ? '\n' : '') + block.text;
        continue;
      }
      if (block.type === 'tool_use') {
        pushText(role, text, timestamp);
        text = '';
        const toolUseId = String(block.id ?? '');
        const toolMessage: ChatMessage = {
          id: replayMessageId(messages.length),
          role: 'tool',
          content: '',
          toolName: String(block.name ?? 'tool'),
          toolInput: block.input,
          toolUseId,
          timestamp,
        };
        messages.push(toolMessage);
        if (toolUseId) toolMessagesByUseId.set(toolUseId, toolMessage);
        continue;
      }
      if (block.type === 'tool_result') {
        const toolUseId = String(block.tool_use_id ?? '');
        const toolMessage = toolMessagesByUseId.get(toolUseId);
        if (toolMessage) {
          toolMessage.toolResult = contentToToolResult(block.content);
          toolMessage.isError = Boolean(block.is_error);
        }
      }
    }
    pushText(role, text, timestamp);
    if (role === 'assistant' && thinking.length > 0) {
      pushThinkingLog(thinking.join('\n\n'), timestamp);
    }
  }

  // Markers after the last message (e.g. a compaction that ran once the final
  // turn was already on disk).
  while (markerIndex < markers.length) {
    pushMarker(markers[markerIndex]!);
    markerIndex += 1;
  }

  return messages;
}

const warnedCostModels = new Set<string>();

function truncateLine(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function flushThinkingLogForCurrentIteration(): void {
  streamCoalescer.flush('__thinking__');
  const current = useSessionStore.getState().iteration;
  useChatStore.getState().flushThinkingLog(Math.max(1, current?.index ?? 1));
  useChatStore.getState().clearThinking();
}

export function handleSessionStart(msg: WSServerMessage) {
  const vizStart = wsToVizEvent('session.start', msg.payload as Record<string, unknown>);
  if (vizStart) {
    useVizStore.getState().pushEvent(vizStart);
    useVizStore.getState().setActive(true);
  }

  const payload = msg.payload as {
    sessionId: string;
    model: unknown;
    provider: unknown;
    maxContext?: number | undefined;
    projectName?: string | undefined;
    cwd?: string | undefined;
    mode?: string | undefined;
    contextMode?: string | undefined;
    inputCost?: number | undefined;
    outputCost?: number | undefined;
    cacheReadCost?: number | undefined;
    lastInputTokens?: number | undefined;
    reset?: boolean | undefined;
    clearedSessionId?: string | undefined;
    needsSetup?: boolean | undefined;
    providerStatuses?: Array<{
      providerId: string;
      model: string;
      state: 'healthy' | 'degraded' | 'blocked';
      lastErrorKind?: string | null | undefined;
      stateExpiresAt?: number | null | undefined;
      lastFailureAt?: number | null | undefined;
    }>;
    appVersion?: unknown;
    latestVersion?: unknown;
    updateAvailable?: unknown;
  };
  const provider = sessionRouteIdentifier(payload.provider);
  const model = sessionRouteIdentifier(payload.model);
  const prev = useSessionStore.getState().session?.id;
  const isNew = !prev || prev !== payload.sessionId;
  const isReset = isNew || payload.reset;

  // Persist version/update info for the UpdateBanner component.
  if (payload.appVersion || payload.latestVersion) {
    useSessionStore.getState().setUpdateInfo({
      appVersion: String(payload.appVersion ?? ''),
      latestVersion: String(payload.latestVersion ?? ''),
      updateAvailable: Boolean(payload.updateAvailable),
    });
  }

  if (Array.isArray(payload.providerStatuses)) {
    useProviderStatusStore.getState().hydrate(
      payload.providerStatuses.map((status) => ({
        providerId: status.providerId,
        model: status.model,
        state: status.state,
        reason: status.lastErrorKind ?? status.state,
        updatedAt: status.lastFailureAt ?? Date.now(),
        stateExpiresAt: status.stateExpiresAt ?? undefined,
      })),
    );
  }

  if (payload.needsSetup) {
    navigateToView('setup');
  }

  if (isReset) {
    useMemoryInjectorTraceStore.getState().clear();
    useSessionStore.getState().startSession({
      id: payload.sessionId,
      startedAt: Date.now(),
      model,
      provider,
    });
  } else {
    useSessionStore.getState().setSession({
      id: payload.sessionId,
      startedAt: useSessionStore.getState().session?.startedAt ?? Date.now(),
      model,
      provider,
    });
  }

  useSessionStore.getState().setEnv({
    maxContext: payload.maxContext,
    projectRoot: (payload as { projectRoot?: string }).projectRoot ?? '',
    projectName: payload.projectName,
    cwd: payload.cwd,
    mode: payload.mode,
    contextMode: payload.contextMode,
    inputCost: payload.inputCost,
    outputCost: payload.outputCost,
    cacheReadCost: payload.cacheReadCost,
  });
  useConfigStore.getState().setConfig({ provider, model });
  if (isReset) {
    if (!payload.needsSetup && isDesktopShell() && !isRoutePinnedView()) {
      resetUiNavigationToHome({ sidebarOpen: false });
    }
    streamCoalescer.dropAll();
    useChatStore.getState().clearMessages();
    useChatStore.getState().setBoundSessionId(payload.sessionId);
    useUIStore.getState().setSearchActiveMessageId(null);
    useChatStore.getState().setLoading(false);
    useSessionStore.setState({ todos: [] });
    setFaviconStatus('ready');

    const fleet = useFleetStore.getState();
    if (payload.clearedSessionId) {
      const survivors = new Map<string, SubagentView>();
      for (const [id, agent] of fleet.agents) {
        if (agent.sessionId !== payload.clearedSessionId) {
          survivors.set(id, agent);
        }
      }
      useFleetStore.setState({ agents: survivors });
    } else {
      fleet.clear();
    }

    useFileStore.getState().setTreeLoading(true);
    // Rehydrated tabs are path-only stubs; re-fetch their content from disk,
    // or drop them when the session belongs to a different project.
    reconcileFileTabsAfterEnvChange(useSessionStore.getState().projectRoot);
    getWSClient().send({ type: 'files.tree', payload: { path: useSessionStore.getState().cwd } });
  }
  const replay = (payload as { replayMessages?: ReplayMessage[] }).replayMessages;
  const replayMarkers = (payload as { replayMarkers?: SessionMarker[] }).replayMarkers ?? [];
  if (replay && replay.length > 0) {
    // The server sends a replay on EVERY connect, including plain reconnects.
    // On a reconnect the local transcript may hold client-only messages the
    // server never persisted (/stats output, provider-error bubbles,
    // compaction notices) — overwriting it would silently drop those. Only
    // replace when the local copy can't be trusted: after a reset, when it's
    // empty or bound to another session, or when a run was in flight at
    // disconnect time (streamed chunks were lost; the replay is the recovery
    // path and beats keeping a truncated transcript).
    const chat = useChatStore.getState();
    const shouldReplace =
      isReset ||
      chat.messages.length === 0 ||
      chat.boundSessionId !== payload.sessionId ||
      chat.isLoading;
    if (shouldReplace) {
      chat.setMessages(hydrateReplayMessages(replay, replayMarkers));
      // The transcript we just hydrated belongs to the active session —
      // bind it so any cross-session bleed check in the verifier view knows
      // these messages are real, not leftovers from a prior session.
      chat.setBoundSessionId(payload.sessionId);
    }
  }
  if (replay) {
    const usage = (
      payload as {
        replayUsage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      }
    ).replayUsage;
    if (usage) {
      const rates = useSessionStore.getState();
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;
      useSessionStore.setState({
        totalTokens: { input, output, cacheRead, cacheWrite },
        cost:
          (input * rates.inputCost + output * rates.outputCost + cacheRead * rates.cacheReadCost) /
          1_000_000,
      });
    }
    // Restore the last known context token estimate from the server so the
    // context-fill bar shows the correct value immediately after F5/reconnect,
    // rather than staying at 0% until the next ctx.pct event.
    const serverLastInput = (payload as { lastInputTokens?: number }).lastInputTokens;
    if (typeof serverLastInput === 'number' && serverLastInput > 0) {
      useSessionStore.setState({ lastInputTokens: serverLastInput });
    }
    if (isReset && !payload.needsSetup) {
      if (!isRoutePinnedView()) {
        if (isDesktopShell()) resetUiNavigationToHome({ sidebarOpen: false });
        else if (useUIStore.getState().currentView !== 'chat') showPanel('chat');
      }
    }
    if (isMobileViewport()) {
      useUIStore.getState().setSidebarOpen(false);
    }
  }
}

export function handleContextDebug(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
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
  useChatStore.getState().addMessage({
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

export function handleKeyOperationResult(msg: WSServerMessage) {
  const p = msg.payload as { success: boolean; message: string };
  if (p.success) toast.success(p.message);
  else toast.error(p.message);
  const client = getWSClient(useConfigStore.getState().wsUrl);
  client.listSavedProviders();
}

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

  // session.start normally arrives immediately before this result. Apply the
  // target again defensively so a dropped/reordered session.start cannot leave
  // the header showing the previous model.
  useConfigStore.getState().setProvider(p.provider);
  useConfigStore.getState().setModel(p.model);
  const from =
    p.previousProvider && p.previousModel
      ? `${p.previousProvider} / ${p.previousModel}`
      : i18n.t('settings:toast.previousModel');
  const to = `${p.provider} / ${p.model}`;
  useChatStore.getState().addMessage({
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
  if (!isActiveSessionMessage(msg)) return;
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
  useChatStore.getState().addMessage({
    role: 'system',
    content: `🗜️ Context compacted: ${payload.before} → ${payload.after} tokens (saved ~${payload.saved}). ${summary}`,
  });
  useSessionStore.setState({ lastInputTokens: payload.after });
}

export function handleCompactionFailed(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
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
    // Prefer budget-derived load when the server supplies it (more accurate than tokens/maxContext).
    load = Math.min(100, Math.max(0, Math.round(payload.budget.load * 100)));
    label = 'input budget';
  } else {
    load =
      payload.maxContext > 0
        ? Math.min(100, Math.max(0, Math.round((payload.tokens / payload.maxContext) * 100)))
        : 0;
    label = 'context';
  }
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `Compaction failed at ${payload.level} (${load}% ${label}): ${payload.message}`,
    isError: payload.fatal,
  });
  toast.error(`Compaction failed: ${payload.message}`);
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
    stopReason: string;
    messageId: string;
    content?: unknown;
  };
  const responseText = providerResponseText(payload.content);

  const u = payload.usage;
  const delta = (u.input ?? 0) + (u.cacheWrite ?? 0) - (u.cacheRead ?? 0);
  if (delta > 0) useSessionStore.setState({ lastInputTokens: delta });

  useSessionStore.getState().updateUsage(payload.usage);
  const { inputCost, outputCost, cacheReadCost } = useSessionStore.getState();
  const dCost =
    (payload.usage.input * inputCost +
      payload.usage.output * outputCost +
      (payload.usage.cacheRead ?? 0) * cacheReadCost) /
    1_000_000;
  if (dCost > 0) useSessionStore.getState().addCost(dCost);
  // Does this response end the turn, or is the agent loop about to run another
  // tool? Mid-turn responses still get finalized (the bubble must stop showing
  // a typing indicator) but their <nextsteps> block is stripped without
  // persisting the steps, so no suggestion bar appears while work is in flight.
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
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `Provider fallback: \`${from}\` returned ${payload.status}; switching to \`${to}\`${payload.providerSwitched ? ' with provider change' : ''}.`,
  });
  toast.warn(`Fallback to ${to}`);
  // Clear the pending fallback modal ONLY when the completion correlates
  // with the active pending request. Gate-mediated fallbacks carry the
  // gate's requestId — match on it so an older completion for the same
  // failed primary cannot clear a NEWER pending modal (parallel-request
  // race). Gate-less fallbacks (no modal was ever shown) carry no
  // requestId and match on `from`.
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
  const p = msg.payload as { target: string; task: string };
  const task = truncateLine(p.task, 180);
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `Delegating to \`${p.target}\`: ${task}`,
  });
  useFleetStore.getState().pushAgentTimelineEntry({
    subagentId: p.target,
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
  useFleetStore.getState().pushAgentTimelineEntry({
    subagentId: p.subagentId ?? p.target,
    agentName: p.target,
    content: p.summary,
    kind: p.ok ? 'status' : 'error',
    iteration: p.iterations,
    ts: new Date().toISOString(),
    status: p.status ?? (p.ok ? 'completed' : 'failed'),
  });
  if (!p.ok) toast.warn(`Delegate failed: ${p.target}`);
}

export function handleTrustPersisted(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as { tool: string; pattern: string; decision: 'always' | 'deny' };
  const label = `${p.tool}: ${p.pattern}`;
  if (p.decision === 'always') toast.success(`Always allowed ${label}`);
  else toast.warn(`Denied ${label}`);
}

export function handleContextRepaired(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
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
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `Context repaired: removed ${removed} orphan protocol item(s).${msgCount} tool_use ${payload.removedToolUses.length}, tool_result ${payload.removedToolResults.length}.`,
  });
}

export function handleContextPct(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  pipeViz(msg);
  const p = msg.payload as { load: number; tokens: number; maxContext: number };
  useSessionStore.getState().setContextUsage(p.tokens, p.maxContext);
}

export function handleContextMaxContext(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as {
    providerId?: string | undefined;
    modelId?: string | undefined;
    maxContext: number;
    previousMaxContext?: number | undefined;
    source?: 'configured' | 'provider' | 'provider_overflow' | undefined;
    decreased?: boolean | undefined;
  };
  const store = useSessionStore.getState();
  store.setEnv({ maxContext: p.maxContext });
  if (
    p.source === 'provider' &&
    p.decreased === true &&
    typeof p.previousMaxContext === 'number' &&
    p.previousMaxContext > p.maxContext
  ) {
    store.setContextLimitWarning({
      previousMaxContext: p.previousMaxContext,
      maxContext: p.maxContext,
      providerId: p.providerId ?? store.session?.provider ?? 'provider',
      modelId: p.modelId ?? store.session?.model ?? 'model',
    });
  } else if (p.decreased === false || p.source === 'configured') {
    store.setContextLimitWarning(null);
  }
}

export function handleTokenThreshold(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as { used: number; limit: number };
  useSessionStore.getState().setContextUsage(p.used, p.limit);
  const pct = p.limit > 0 ? Math.round((p.used / p.limit) * 100) : 0;
  toast.warn(`Token threshold reached (${pct}%)`);
}

export function handleTokenCostEstimateUnavailable(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as { model: string };
  const model = p.model || '<unknown>';
  if (warnedCostModels.has(model)) return;
  warnedCostModels.add(model);
  toast.warn(`Cost estimate unavailable for ${model}`);
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
  // Deliberately does NOT touch `wsConnected`.
  //
  // That flag means "is the SOCKET up", and `setWsStatus` derives it from
  // `wsStatus.state === 'open'` — transport truth. Writing `false` here on a
  // server *message*, with the socket perfectly healthy, latched it forever:
  // `setStatus` only fires on socket transitions, so on a live connection no
  // further status event ever arrives to undo it. The moment an agent run
  // finished, SidePanel stopped loading the file tree, SessionPanel stopped
  // refreshing `sessions.list`, the activity bar showed a grey "disconnected"
  // dot, and CheckpointTimeline / ProcessMonitor / SessionsDashboard /
  // SessionInspectView all went inert until an F5.

  // Signal ChatView to expand the input so next-steps selections land in a
  // visible textarea instead of a collapsed bar.
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('chat:session-end'));
  }
}

export function handleContextModesList(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
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
  useSessionStore.getState().setContextModes(
    p.modes.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      thresholds: m.thresholds,
      preserveK: m.preserveK,
      eliseThreshold: m.eliseThreshold,
      custom: m.custom,
    })),
  );
  useSessionStore.getState().setEnv({ contextMode: p.activeId });
}

export function handleContextModeChanged(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as { id: string; name?: string | undefined };
  useSessionStore.getState().setEnv({ contextMode: p.id });
}

export function handleSessionsList(msg: WSServerMessage) {
  const payload = msg.payload as { sessions: SessionHistoryEntry[]; error?: string | undefined };
  useHistoryStore.getState().setEntries(payload.sessions ?? [], payload.error ?? null);
}

export function handleError(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const payload = msg.payload as { phase: string; message: string };
  // Benign session-guard rejection from the initial todos fetch — fires when a
  // stale sessionId is used before the new session is established. Suppress so
  // it doesn't pollute chat history on first open.
  if (payload.phase === 'todos.get') return;
  flushThinkingLogForCurrentIteration();
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `[${payload.phase}] ${payload.message}`,
    isError: true,
  });
  useChatStore.getState().setLoading(false);
}

export const sessionHandlerMap: Partial<Record<string, (msg: WSServerMessage) => void>> = {
  'context.debug': handleContextDebug,
  'key.operation_result': handleKeyOperationResult,
  'model.switch_result': handleModelSwitchResult,
  'context.compacted': handleContextCompacted,
  'compaction.failed': handleCompactionFailed,
  'provider.response': handleProviderResponse,
  'iteration.completed': handleIterationCompleted,
  'iteration.limit_reached': handleIterationLimitReached,
  'provider.retry': handleProviderRetry,
  'provider.error': handleProviderError,
  'provider.fallback': handleProviderFallback,
  'provider.fallback_pending': handleProviderFallbackPending,
  'provider.status_changed': handleProviderStatusChanged,
  'provider.active_blocked': handleProviderActiveBlocked,
  'provider.stream_error': handleProviderStreamError,
  'tool.loop_detected': handleToolLoopDetected,
  'delegate.started': handleDelegateStarted,
  'delegate.completed': handleDelegateCompleted,
  'trust.persisted': handleTrustPersisted,
  'context.repaired': handleContextRepaired,
  'ctx.pct': handleContextPct,
  'ctx.max_context': handleContextMaxContext,
  'token.threshold': handleTokenThreshold,
  'token.cost_estimate_unavailable': handleTokenCostEstimateUnavailable,
  'session.end': handleSessionEnd,
  'session.damaged': handleSessionDamaged,
  'session.rewound': handleSessionRewound,
  'checkpoint.written': handleCheckpointWritten,
  'in_flight.started': handleInFlightStarted,
  'in_flight.ended': handleInFlightEnded,
  'context.modes.list': handleContextModesList,
  'context.mode.changed': handleContextModeChanged,
  'sessions.list': handleSessionsList,
  'provider.status.snapshot': handleProviderStatusSnapshot,
  error: handleError,
};
