import { toast } from '@/components/Toaster';
import { isDesktopShell } from '@/lib/desktop-shell';
import { setFaviconStatus } from '@/lib/favicon';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { getWSClient } from '@/lib/ws-client';
import { isActiveSessionMessage, pipeViz } from '@/lib/ws-client-utils';
import { navigateToView, showPanel } from '@/lib/view-navigation';
import type { ChatMessage, SessionHistoryEntry, SubagentView } from '@/stores';
import {
  useChatStore,
  useConfigStore,
  useFileStore,
  useFleetStore,
  useHistoryStore,
  resetUiNavigationToHome,
  useSessionStore,
  useUIStore,
} from '@/stores';
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

function hydrateReplayMessages(replay: ReplayMessage[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const toolMessagesByUseId = new Map<string, ChatMessage>();
  let thinkingLogIteration = 0;

  const pushText = (role: 'user' | 'assistant' | 'system', content: string, timestamp: number) => {
    if (!content) return;
    messages.push({ id: replayMessageId(messages.length), role, content, timestamp });
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
    model: string;
    provider: string;
    maxContext?: number | undefined;
    projectName?: string | undefined;
    cwd?: string | undefined;
    mode?: string | undefined;
    contextMode?: string | undefined;
    inputCost?: number | undefined;
    outputCost?: number | undefined;
    cacheReadCost?: number | undefined;
    reset?: boolean | undefined;
    clearedSessionId?: string | undefined;
    needsSetup?: boolean | undefined;
  };
  const prev = useSessionStore.getState().session?.id;
  const isNew = !prev || prev !== payload.sessionId;
  const isReset = isNew || payload.reset;

  if (payload.needsSetup) {
    navigateToView('setup');
  }

  if (isReset) {
    useSessionStore.getState().startSession({
      id: payload.sessionId,
      startedAt: Date.now(),
      model: payload.model,
      provider: payload.provider,
    });
  } else {
    useSessionStore.getState().setSession({
      id: payload.sessionId,
      startedAt: useSessionStore.getState().session?.startedAt ?? Date.now(),
      model: payload.model,
      provider: payload.provider,
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
  useConfigStore.getState().setConfig({
    provider: payload.provider,
    model: payload.model,
  });
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
    getWSClient().send({ type: 'files.tree', payload: { path: useSessionStore.getState().cwd } });
  }
  const replay = (payload as { replayMessages?: ReplayMessage[] }).replayMessages;
  if (replay && replay.length > 0) {
    useChatStore.getState().setMessages(hydrateReplayMessages(replay));
    // The transcript we just hydrated belongs to the active session —
    // bind it so any cross-session bleed check in the verifier view knows
    // these messages are real, not leftovers from a prior session.
    useChatStore.getState().setBoundSessionId(payload.sessionId);
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
    if (isReset && !payload.needsSetup) {
      if (!isRoutePinnedView()) {
        if (isDesktopShell()) resetUiNavigationToHome({ sidebarOpen: false });
        else if (useUIStore.getState().currentView !== 'chat') showPanel('chat');
      }
    }
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 768px)').matches) {
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
    role: 'assistant',
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
  if (payload.stopReason !== 'tool_use' && payload.stopReason !== 'tool_call')
    useChatStore.getState().setLoading(false);
  const id = useChatStore.getState().currentAssistantMessageId;
  if (id) {
    streamCoalescer.flush(id);
    const streamed = useChatStore.getState().messages.find((m) => m.id === id);
    const streamedText = streamed?.content ?? '';
    if (responseText.trim()) {
      if (!streamedText.trim()) {
        useChatStore.getState().updateMessage(id, { content: responseText });
      } else if (responseText.startsWith(streamedText) && responseText.length > streamedText.length) {
        useChatStore.getState().updateMessage(id, { content: responseText });
      }
    }
    useChatStore.getState().finalizeMessage(id);
    if (payload.usage.output > 0)
      useChatStore.getState().updateMessage(id, { usage: payload.usage });
  } else if (responseText.trim()) {
    const messageId = useChatStore.getState().addMessage({
      role: 'assistant',
      content: responseText,
      usage: payload.usage.output > 0 ? payload.usage : undefined,
    });
    useChatStore.getState().finalizeMessage(messageId);
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
  };
  const from = `${payload.from.providerId}/${payload.from.model}`;
  const to = `${payload.to.providerId}/${payload.to.model}`;
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `Provider fallback: \`${from}\` returned ${payload.status}; switching to \`${to}\`${payload.providerSwitched ? ' with provider change' : ''}.`,
  });
  toast.warn(`Fallback to ${to}`);
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
  };
  const subject = p.tools || p.kind || 'assistant response';
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `Loop guard triggered: ${subject} repeated ${p.repeatCount} time(s) at iteration ${p.iteration}.`,
    isError: true,
  });
  toast.warn('Loop guard triggered');
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
  const p = msg.payload as { maxContext: number };
  useSessionStore.getState().setEnv({ maxContext: p.maxContext });
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
  useConfigStore.getState().setWsConnected(false);
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
  'context.compacted': handleContextCompacted,
  'compaction.failed': handleCompactionFailed,
  'provider.response': handleProviderResponse,
  'iteration.completed': handleIterationCompleted,
  'iteration.limit_reached': handleIterationLimitReached,
  'provider.retry': handleProviderRetry,
  'provider.error': handleProviderError,
  'provider.fallback': handleProviderFallback,
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
  error: handleError,
};
