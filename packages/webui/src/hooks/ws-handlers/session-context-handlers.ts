import { toast } from '@/components/Toaster';
import { i18n } from '@/i18n';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { getWSClient } from '@/lib/ws-client';
import { isActiveSessionMessage, pipeViz } from '@/lib/ws-client-utils';
import { useChatStore, useConfigStore, useSessionStore } from '@/stores';
import type { WSServerMessage } from '@/types';

export const warnedCostModels = new Set<string>();

export function flushThinkingLogForCurrentIteration(): void {
  streamCoalescer.flush('__thinking__');
  const current = useSessionStore.getState().iteration;
  useChatStore.getState().flushThinkingLog(Math.max(1, current?.index ?? 1));
  useChatStore.getState().clearThinking();
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
  if (!p || typeof p.message !== 'string') return;
  // Session transitions / tab switches must be silent without popup toast noise
  if (
    p.message.startsWith('Resumed session') ||
    p.message.includes('Session is already active') ||
    p.message.startsWith('Swapped session')
  ) {
    return;
  }
  if (p.success) toast.success(p.message);
  else toast.error(p.message);
  const client = getWSClient(useConfigStore.getState().wsUrl);
  client.listSavedProviders();
}

export function handleModelSwitchResult(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as {
    success: boolean;
    provider?: string | undefined;
    model?: string | undefined;
    previousProvider?: string | undefined;
    previousModel?: string | undefined;
    runActive: boolean;
  };
  if (!p.success || !p.provider || !p.model) return;

  useConfigStore.getState().setProvider(p.provider);
  useConfigStore.getState().setModel(p.model);
  const currentSession = useSessionStore.getState().session;
  if (currentSession) {
    useSessionStore.getState().setSession({
      ...currentSession,
      provider: p.provider,
      model: p.model,
    });
  }
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

export function handleError(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const payload = msg.payload as { phase: string; message: string };
  if (payload.phase === 'todos.get') return;
  flushThinkingLogForCurrentIteration();
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: `[${payload.phase}] ${payload.message}`,
    isError: true,
  });
  useChatStore.getState().setLoading(false);
}
