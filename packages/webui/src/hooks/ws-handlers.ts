import { expectDefined, normalizedEqual } from '@wrongstack/core';
import { toast } from '@/components/Toaster';
import { playCompletionChime, playPermissionChime } from '@/lib/chime';
import { setFaviconStatus } from '@/lib/favicon';
import { ensureNotificationPermission, notifyIfHidden } from '@/lib/notify';
import { getWSClient } from '@/lib/ws-client';
import { streamCoalescer } from '@/lib/stream-coalescer';
import type { WrongStackWebSocketClient } from '@/lib/ws-client';
import type { PhaseItem } from '@/components/PhasePanel';
import {
  type SessionHistoryEntry,
  type SubagentEvent,
  type SubagentView,
  useAutoPhaseStore,
  useChatStore,
  useConfigStore,
  useFleetStore,
  useGoalStore,
  useHistoryStore,
  useSessionStore,
  useUIStore,
  useWorktreeStore,
  useFileStore,
} from '@/stores';
import { useVizStore, wsToVizEvent } from '@/stores/viz-store';
import { useLocalPrefs } from '@/stores/local-prefs';
import { useMailboxStore, type MailboxAgent, type MailboxMessage } from '@/stores/mailbox-store';
import type { WorktreeHandleView, WSServerMessage } from '@/types';
// ── Session handlers ──

export function handleSessionStart(msg: WSServerMessage) {
  // Pipe to viz store — session start creates the session node
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
    /** Session ID that was just closed — only present on project switch.
     *  Used to selectively clear agents from the old session. */
    clearedSessionId?: string | undefined;
    /** True when no provider+model is configured yet — show the setup screen. */
    needsSetup?: boolean | undefined;
  };
  const prev = useSessionStore.getState().session?.id;
  const isNew = !prev || prev !== payload.sessionId;
  const isReset = isNew || payload.reset;

  // If the server says no provider/model is configured, switch to the setup screen.
  if (payload.needsSetup) {
    useUIStore.getState().setCurrentView('setup');
  }

  // Only fully reset the session when it's genuinely new or the server
  // explicitly requests a reset. Model/mode switches update metadata
  // without wiping token counters, cost, or elapsed time.
  if (isReset) {
    useSessionStore.getState().startSession({
      id: payload.sessionId,
      startedAt: Date.now(),
      model: payload.model,
      provider: payload.provider,
    });
  } else {
    // Same session, no reset: update model/provider in-place.
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
    useChatStore.getState().clearMessages();
    // A reset means any in-flight run belonged to the session we just left
    // (resume / new / project switch) — drop the streaming flag and stale
    // plan so the input, Abort button, and tab indicator don't stay stuck
    // on the old session's state.
    useChatStore.getState().setLoading(false);
    useSessionStore.setState({ todos: [] });
    setFaviconStatus('ready');

    // Selectively clear fleet agents — if the server tells us which
    // session was just closed, only remove those agents. Otherwise
    // fall back to clearing everything (session.new / context.clear).
    const fleet = useFleetStore.getState();
    if (payload.clearedSessionId) {
      // Only remove agents from the just-closed session.
      // Surviving agents (if any) stay in the roster.
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

    // Re-fetch the file tree so the explorer shows the new project's files.
    useFileStore.getState().setTreeLoading(true);
    getWSClient().send({ type: 'files.tree', payload: { path: useSessionStore.getState().cwd } });
  }
  // Resume hydration
  const replay = (payload as { replayMessages?: Array<{ role: string | undefined; content: unknown; ts?: string }> }).replayMessages;
  if (replay && replay.length > 0) {
    const chat = useChatStore.getState();
    for (const m of replay) {
      // Preserve the original event timestamp so replayed messages show
      // their real "when" instead of all clustering at "just now".
      const parsedTs = typeof m.ts === 'string' ? Date.parse(m.ts) : Number.NaN;
      const msgTimestamp: number | undefined = Number.isFinite(parsedTs) ? parsedTs : undefined;
      if (m.role === 'user' || m.role === 'assistant' || m.role === 'system') {
        let text = '';
        if (typeof m.content === 'string') {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          for (const b of m.content as Array<Record<string, unknown>>) {
            if (b.type === 'text' && typeof b.text === 'string') {
              text += (text ? '\n' : '') + b.text;
            } else if (b.type === 'tool_use') {
              if (text) { chat.addMessage({ role: m.role as 'user' | 'assistant', content: text, timestamp: msgTimestamp }); text = ''; }
              chat.addMessage({ role: 'tool', content: '', toolName: String(b.name ?? 'tool'), toolInput: b.input, toolUseId: String(b.id ?? ''), timestamp: msgTimestamp });
            } else if (b.type === 'tool_result') {
              const all = useChatStore.getState().messages;
              let last: { id: string } | undefined;
              for (let i = all.length - 1; i >= 0; i--) {
                if (all[i]?.toolUseId === String(b.tool_use_id ?? '')) { last = expectDefined(all[i]); break; }
              }
              if (last) { chat.setToolResult(last.id, typeof b.content === 'string' ? b.content : JSON.stringify(b.content), !b.is_error); }
            }
          }
        }
        if (text) chat.addMessage({ role: m.role as 'user' | 'assistant', content: text, timestamp: msgTimestamp });
      }
    }
  }
  // The replayMessages field is only present on a session.resume — never on
  // connect, session.new, or a project switch (see server session.resume).
  if (replay) {
    // Restore the resumed session's lifetime usage so the Session panel
    // doesn't show zeros. Cost is recomputed from the per-1M rates that
    // arrived in this same payload (close enough to the server's counter).
    const usage = (payload as {
      replayUsage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    }).replayUsage;
    if (usage) {
      const rates = useSessionStore.getState();
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;
      useSessionStore.setState({
        totalTokens: { input, output, cacheRead, cacheWrite },
        cost: (input * rates.inputCost + output * rates.outputCost + cacheRead * rates.cacheReadCost) / 1_000_000,
      });
    }
    // Resuming is always a deliberate "take me back to that conversation" —
    // land on the chat view no matter which surface triggered it.
    if (useUIStore.getState().currentView !== 'chat') {
      useUIStore.getState().setCurrentView('chat');
    }
    // On narrow viewports the side panel covers most of the chat — close it
    // so the resumed conversation is actually visible.
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 768px)').matches) {
      useUIStore.getState().setSidebarOpen(false);
    }
  }
}

// ── Context handlers ──

export function handleContextDebug(msg: WSServerMessage) {
  const p = msg.payload as {
    total: number; systemPrompt: number;
    tools: { total: number; count: number; breakdown: Array<{ name: string; tokens: number }> };
    messages: { total: number; count: number; breakdown: Array<{ index: number; role: string; tokens: number; preview: string }> };
  };
  const fmt = (n: number) => n.toLocaleString();
  const topTools = [...p.tools.breakdown].sort((a, b) => b.tokens - a.tokens).slice(0, 8);
  const topMsgs = [...p.messages.breakdown].sort((a, b) => b.tokens - a.tokens).slice(0, 8);
  useChatStore.getState().addMessage({ role: 'assistant', content: [
    `📊 **Context breakdown** (heuristic — 4 chars/token)`, '',
    `**Total estimate:** ${fmt(p.total)} tokens`,
    `• System prompt: ${fmt(p.systemPrompt)}`,
    `• Tool schemas: ${fmt(p.tools.total)} (${p.tools.count} tools)`,
    `• Messages: ${fmt(p.messages.total)} (${p.messages.count} messages)`, '',
    `**Top tool schemas:**`, ...topTools.map((t) => `  · ${t.name}: ${fmt(t.tokens)}`), '',
    `**Top messages:**`, ...topMsgs.map((m) => `  · #${m.index} ${m.role}: ${fmt(m.tokens)} — ${m.preview || '(empty)'}`),
  ].join('\n') });
}

export function handleKeyOperationResult(msg: WSServerMessage) {
  const p = msg.payload as { success: boolean; message: string };
  if (p.success) toast.success(p.message);
  else toast.error(p.message);
  // Refresh saved providers after any key operation so the SettingsPanel
  // (and any other viewer) immediately sees the updated list.
  const client = getWSClient(useConfigStore.getState().wsUrl);
  client.listSavedProviders();
}

export function handleContextCompacted(msg: WSServerMessage) {
  pipeViz(msg);
  const payload = msg.payload as {
    before: number; after: number; saved: number;
    reductions: Array<{ phase: string; saved: number }>;
    repaired?: { removedToolUses: string[] | undefined; removedToolResults: string[]; removedMessages: number };
  };
  let summary = payload.reductions.length ? payload.reductions.map((r) => `${r.phase}: ${r.saved}`).join(', ') : 'no-op';
  if (payload.repaired) summary += `; repaired ${payload.repaired.removedToolUses?.length ?? 0} tool_use, ${payload.repaired.removedToolResults?.length ?? 0} tool_result, ${payload.repaired.removedMessages} empty messages`;
  useChatStore.getState().addMessage({ role: 'assistant', content: `🗜️ Context compacted: ${payload.before} → ${payload.after} tokens (saved ~${payload.saved}). ${summary}` });
  useSessionStore.setState({ lastInputTokens: payload.after });
}

export function handleProviderResponse(msg: WSServerMessage) {
  const payload = msg.payload as { usage: { input: number; output: number; cacheRead?: number | undefined; cacheWrite?: number | undefined }; stopReason: string; messageId: string };

  // Update lastInputTokens from usage delta (was a separate handler)
  const u = payload.usage;
  const delta = (u.input ?? 0) + (u.cacheWrite ?? 0) - (u.cacheRead ?? 0);
  if (delta > 0) useSessionStore.setState({ lastInputTokens: delta });

  // Main response handler
  useSessionStore.getState().updateUsage(payload.usage);
  const { inputCost, outputCost, cacheReadCost } = useSessionStore.getState();
  const dCost = (payload.usage.input * inputCost + payload.usage.output * outputCost + (payload.usage.cacheRead ?? 0) * cacheReadCost) / 1_000_000;
  if (dCost > 0) useSessionStore.getState().addCost(dCost);
  if (payload.stopReason !== 'tool_use' && payload.stopReason !== 'tool_call') useChatStore.getState().setLoading(false);
  const id = useChatStore.getState().currentAssistantMessageId;
  if (id) {
    // Drain any buffered tokens for this message before finalizing so the
    // dedupe/streaming-off pass sees the complete text.
    streamCoalescer.flush(id);
    useChatStore.getState().finalizeMessage(id);
    if (payload.usage.output > 0) useChatStore.getState().updateMessage(id, { usage: payload.usage });
  }
  useChatStore.getState().setCurrentAssistantMessage(null);
  useChatStore.getState().clearThinking();
}

export function handleContextRepaired(msg: WSServerMessage) {
  const payload = msg.payload as { removedToolUses: string[]; removedToolResults: string[]; removedMessages: number; beforeMessages?: number | undefined; afterMessages?: number | undefined };
  const removed = payload.removedToolUses.length + payload.removedToolResults.length + payload.removedMessages;
  const msgCount = payload.beforeMessages !== undefined && payload.afterMessages !== undefined ? ` Messages: ${payload.beforeMessages} -> ${payload.afterMessages}.` : '';
  useChatStore.getState().addMessage({ role: 'assistant', content: `Context repaired: removed ${removed} orphan protocol item(s).${msgCount} tool_use ${payload.removedToolUses.length}, tool_result ${payload.removedToolResults.length}.` });
}

// ── Agent handlers ──

export function handleSessionEnd() {
  useConfigStore.getState().setWsConnected(false);
}

export function handleIterationStarted(msg: WSServerMessage) {
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
  const payload = msg.payload as { text: string; messageId: string };
  useChatStore.getState().clearThinking();
  streamCoalescer.drop('__thinking__');
  let id = useChatStore.getState().currentAssistantMessageId;
  if (!id) {
    id = useChatStore.getState().addMessage({ role: 'assistant', content: '', streaming: true });
    useChatStore.getState().setCurrentAssistantMessage(id);
  }
  // Coalesce per-token deltas into one store write per frame — see
  // stream-coalescer.ts. Keyed by the assistant message id.
  streamCoalescer.push(id, payload.text, (mid, text) =>
    useChatStore.getState().appendToMessage(mid, text),
  );
}

export function handleThinkingDelta(msg: WSServerMessage) {
  const payload = msg.payload as { text: string };
  if (!payload.text) return;
  streamCoalescer.push('__thinking__', payload.text, (_k, text) =>
    useChatStore.getState().appendThinking(text),
  );
}

export function handleToolStarted(msg: WSServerMessage) {
  const payload = msg.payload as { id: string; name: string; input?: unknown | undefined; messageId: string };
  const existing = useChatStore.getState().messages.find((m) => m.toolUseId === payload.id);
  if (existing) { useChatStore.getState().setCurrentToolId(existing.id); return; }
  useChatStore.getState().clearThinking();
  streamCoalescer.drop('__thinking__');
  useChatStore.getState().setCurrentAssistantMessage(null);
  const id = useChatStore.getState().addMessage({ role: 'tool', content: '', toolName: payload.name, toolInput: payload.input, toolUseId: payload.id });
  useChatStore.getState().setCurrentToolId(id);
  useChatStore.getState().addExecution({ id: payload.id, name: payload.name, input: payload.input, ok: true, startedAt: Date.now() });
}

export function handleToolProgress(msg: WSServerMessage) {
  const payload = msg.payload as { id: string; name: string; event: { type: string; text?: string | undefined } };
  const text = (payload.event?.text ?? '').trim();
  if (!text) return;
  const messages = useChatStore.getState().messages;
  const owner = messages.find((m) => m.toolUseId === payload.id);
  if (!owner) return;
  const prefix = payload.event?.type === 'warning' ? '⚠ ' : '';
  // Coalesce progress lines per owner; flush splits back into lines and does a
  // single store write. Lines are newline-joined in the buffer.
  streamCoalescer.push(owner.id, `${prefix}${text}\n`, (oid, buffered) =>
    useChatStore.getState().appendToolProgressLines(
      oid,
      buffered.split('\n').filter((l) => l.length > 0),
    ),
  );
}

export function handleToolExecuted(msg: WSServerMessage) {
  const payload = msg.payload as { id?: string | undefined; name: string; durationMs: number; ok: boolean; input?: unknown | undefined; output?: string | undefined };
  const { messages, currentToolId } = useChatStore.getState();
  const owner = payload.id ? messages.find((m) => m.toolUseId === payload.id) : currentToolId ? messages.find((m) => m.id === currentToolId) : undefined;
  if (owner?.toolResult !== undefined) return;
  if (owner) {
    // The final result replaces progress lines — discard any still-buffered
    // progress so it can't re-add a progressLines array a frame later.
    streamCoalescer.drop(owner.id);
    useChatStore.getState().setToolResult(owner.id, payload.output ?? '', payload.ok);
    useChatStore.getState().updateMessage(owner.id, { toolDurationMs: payload.durationMs });
  }
  if (payload.id) useChatStore.getState().updateExecution(payload.id, { completedAt: Date.now(), durationMs: payload.durationMs, output: payload.output, ok: payload.ok });
  if (currentToolId && owner && owner.id === currentToolId) useChatStore.getState().setCurrentToolId(null);
}

export function handleToolConfirmNeeded(msg: WSServerMessage) {
  const payload = msg.payload as { id: string; toolName: string; input: unknown; suggestedPattern: string };
  useUIStore.getState().showConfirm({ id: payload.id, toolName: payload.toolName, input: payload.input, suggestedPattern: payload.suggestedPattern });
  try { playPermissionChime(); } catch { /* audio policy */ }
  void ensureNotificationPermission();
  const label = useSessionStore.getState().projectName || 'Agent';
  notifyIfHidden(`${label} needs approval`, `Tool "${payload.toolName}" is waiting for your decision.`, 'agent-confirm');
  if (typeof document !== 'undefined' && document.hidden) setFaviconStatus('attention');
}

export function handleRunResult(msg: WSServerMessage) {
  const payload = msg.payload as { status: string; iterations: number; finalText?: string | undefined; error?: { code: string | undefined; message: string; recoverable: boolean } };
  // Drain all buffered stream text before we read messages for the run summary.
  streamCoalescer.flushAll();
  useSessionStore.getState().setIteration(null);
  useChatStore.getState().setLoading(false);
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
      useChatStore.getState().updateMessage(all[lastAssistantIdx]?.id, { runSummary: { iterations: payload.iterations, tools: toolCount, durationMs: Date.now() - runStart.at, costDelta: Math.max(0, sessionCost - runStart.cost) } });
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
      toast.success(`Run completed in ${payload.iterations} iteration${payload.iterations === 1 ? '' : 's'}`);
      notifyIfHidden(`${useSessionStore.getState().projectName || 'Agent'} run finished`, `Completed in ${payload.iterations} iteration${payload.iterations === 1 ? '' : 's'}.`);
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
    useChatStore.getState().addMessage({ role: 'user', content: next });
    useChatStore.getState().setLoading(true);
    client.sendMessage(next);
  }
}

// ── Info / misc handlers ──

export function handleToolsList(msg: WSServerMessage) {
  const p = msg.payload as { tools: Array<{ name: string; description: string; params: string[] }> };
  useChatStore.getState().addMessage({ role: 'assistant', content: [
    `🛠️ **Registered tools** (${p.tools.length})`, '',
    ...p.tools.map((t) => `• \`${t.name}\`${t.params.length ? ` (${t.params.join(', ')})` : ''} — ${t.description || '_no description_'}`),
  ].join('\n') });
}

export function handleMemoryList(msg: WSServerMessage) {
  const p = msg.payload as { text: string; error?: string | undefined };
  const body = p.text?.trim();
  useChatStore.getState().addMessage({ role: 'assistant', content: p.error ? `Memory read failed: ${p.error}` : body ? `🧠 **Memory** \n\n${body}` : '🧠 **Memory** \n\n_empty — nothing remembered yet_' });
}

export function handleSkillsList(msg: WSServerMessage) {
  const p = msg.payload as { enabled: boolean; error?: string | undefined; skills: Array<{ name: string; description: string; version: string; source: string; path: string; trigger: string; scope: string[] }> };
  if (!p.enabled) { useChatStore.getState().addMessage({ role: 'assistant', content: '🎯 **Skills** \n\n_disabled (config.features.skills = false)_' }); return; }
  const lines = [`🎯 **Skills** (${p.skills.length})`, '', ...(p.skills.length === 0 ? ['_none registered_'] : p.skills.map((s) => `• \`${s.name}\`${s.version ? ` v${s.version}` : ''} _(${s.source})_ — ${s.description || s.trigger || '_no description_'}`))];
  if (p.error) lines.push('', `⚠ ${p.error}`);
  useChatStore.getState().addMessage({ role: 'assistant', content: lines.join('\n') });
}

export function handleDiagGet(msg: WSServerMessage) {
  const p = msg.payload as { provider: string; model: string; cwd: string; sessionId: string; tools: { count: number; names: string[] }; features: { memory: boolean; skills: boolean; modelsRegistry: boolean }; mode: string; usage: { input: number; output: number; cacheRead?: number | undefined }; messages: number; todos: number };
  useChatStore.getState().addMessage({ role: 'assistant', content: [
    '🩺 **Runtime diagnostics**', '',
    `**Provider:** \`${p.provider}\` / \`${p.model}\``,
    `**Mode:** \`${p.mode}\``, `**Session:** \`${p.sessionId}\``, `**CWD:** \`${p.cwd}\``, '',
    `**Tools:** ${p.tools.count}`, `**Messages:** ${p.messages}  ·  **Todos:** ${p.todos}`,
    `**Usage:** ${p.usage.input.toLocaleString()} in · ${p.usage.output.toLocaleString()} out${p.usage.cacheRead ? ` · ${p.usage.cacheRead.toLocaleString()} cache` : ''}`, '',
    `**Features:** memory=${p.features.memory ? '✓' : '✗'} · skills=${p.features.skills ? '✓' : '✗'} · modelsRegistry=${p.features.modelsRegistry ? '✓' : '✗'}`,
  ].join('\n') });
}

export function handleStatsGet(msg: WSServerMessage) {
  const p = msg.payload as { sessionId: string; provider: string; model: string; usage: { input: number; output: number; cacheRead?: number | undefined; cacheWrite?: number | undefined }; cache: { readTokens: number; writeTokens: number; hitRatio: number } | null; cost: number; messages: number; readFiles: number; tools: number; elapsedMs: number };
  const elapsedSec = Math.floor(p.elapsedMs / 1000);
  const elapsed = elapsedSec < 60 ? `${elapsedSec}s` : elapsedSec < 3600 ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s` : `${Math.floor(elapsedSec / 3600)}h ${Math.floor((elapsedSec % 3600) / 60)}m`;
  useChatStore.getState().addMessage({ role: 'assistant', content: [
    '📈 **Session stats**', '',
    `**Session:** \`${p.sessionId}\``, `**Provider/Model:** \`${p.provider}\` / \`${p.model}\``, `**Elapsed:** ${elapsed}`, '',
    `**Usage:** ${p.usage.input.toLocaleString()} in · ${p.usage.output.toLocaleString()} out`,
    ...(p.cache && p.cache.readTokens > 0 ? [`**Cache:** ${p.cache.readTokens.toLocaleString()} read · ${p.cache.writeTokens.toLocaleString()} write · hit ratio ${(p.cache.hitRatio * 100).toFixed(1)}%`] : []),
    `**Cost:** $${p.cost.toFixed(4)}`, '',
    `**Messages:** ${p.messages}  ·  **Files read:** ${p.readFiles}  ·  **Tools available:** ${p.tools}`,
  ].join('\n') });
}

export function handleTodosUpdated(msg: WSServerMessage) {
  const p = msg.payload as { todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string | undefined }> };
  useSessionStore.getState().setTodos(p.todos ?? []);
}

export function handleModesList(msg: WSServerMessage) {
  const p = msg.payload as { modes: Array<{ id: string; name: string; description: string; isActive: boolean }>; activeId: string };
  useSessionStore.getState().setModes(p.modes.map((m) => ({ id: m.id, name: m.name, description: m.description })));
  useSessionStore.getState().setEnv({ mode: p.activeId });
}

export function handleContextModesList(msg: WSServerMessage) {
  const p = msg.payload as { activeId: string; modes: Array<{ id: string; name: string; description: string; isActive: boolean; thresholds?: { warn: number | undefined; soft: number; hard: number }; preserveK?: number | undefined; eliseThreshold?: number | undefined; custom?: boolean | undefined }> };
  useSessionStore.getState().setContextModes(p.modes.map((m) => ({ id: m.id, name: m.name, description: m.description, thresholds: m.thresholds, preserveK: m.preserveK, eliseThreshold: m.eliseThreshold, custom: m.custom })));
  useSessionStore.getState().setEnv({ contextMode: p.activeId });
}

export function handleContextModeChanged(msg: WSServerMessage) {
  const p = msg.payload as { id: string; name?: string | undefined };
  useSessionStore.getState().setEnv({ contextMode: p.id });
}

export function handleSessionsList(msg: WSServerMessage) {
  const payload = msg.payload as { sessions: SessionHistoryEntry[]; error?: string | undefined };
  useHistoryStore.getState().setEntries(payload.sessions ?? [], payload.error ?? null);
}

export function handleError(msg: WSServerMessage) {
  const payload = msg.payload as { phase: string; message: string };
  useChatStore.getState().addMessage({ role: 'assistant', content: `[${payload.phase}] ${payload.message}`, isError: true });
  useChatStore.getState().setLoading(false);
}

// ── Worktree / Fleet handlers ──

export function handleWorktreeState(msg: WSServerMessage) {
  const p = msg.payload as { worktrees: WorktreeHandleView[]; baseBranch: string };
  useWorktreeStore.getState().setSnapshot(p.worktrees ?? [], p.baseBranch ?? '');
}

export function handleWorktreeEvent(msg: WSServerMessage) {
  const p = msg.payload as { kind: string; handleId: string; text: string; at: number };
  useWorktreeStore.getState().pushEvent(p);
}

export function handleSubagentEvent(msg: WSServerMessage) {
  useFleetStore.getState().applyEvent(msg.payload as SubagentEvent);
  // Pipe to viz store
  const vizEv = wsToVizEvent('subagent.event', msg.payload as Record<string, unknown>);
  if (vizEv) {
    useVizStore.getState().pushEvent(vizEv);
    useVizStore.getState().setActive(true);
  }
}

export function handleFleetConcurrency(msg: WSServerMessage) {
  const p = msg.payload as { fleetConcurrency: number; fleetConcurrencyMax: number };
  useFleetStore.setState({
    fleetConcurrency: p.fleetConcurrency,
    fleetConcurrencyMax: p.fleetConcurrencyMax,
  });
}

/** Universal viz event pipe — called by every handler that generates a VizEvent. */
function pipeViz(msg: WSServerMessage) {
  const vizEv = wsToVizEvent(msg.type, msg.payload as Record<string, unknown>);
  if (vizEv) {
    useVizStore.getState().pushEvent(vizEv);
    useVizStore.getState().setActive(true);
  }
  return msg; // chainable
}

// ── AutoPhase handler ──

export function handleAutoPhaseState(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown>;
  useAutoPhaseStore.getState().setState({
    phases: Array.isArray(p.phases) ? (p.phases as PhaseItem[]) : undefined,
    activePhaseId: typeof p.activePhaseId === 'string' ? p.activePhaseId : undefined,
    overallPercent: typeof p.overallPercent === 'number' ? p.overallPercent : undefined,
    autonomous: typeof p.autonomous === 'boolean' ? p.autonomous : undefined,
    title: typeof p.title === 'string' ? p.title : undefined,
  });
}

// ── Goal handler ──

export function handleGoalUpdated(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown> | null;
  useGoalStore.getState().setGoal(p);
}

// ── Preferences sync ──
// The server broadcasts prefs.updated whenever any client changes a
// preference. This handler hydrates the local-prefs store so every
// connected browser tab sees the new value immediately.

export function handlePrefsUpdated(msg: WSServerMessage) {
  const p = msg.payload as Record<string, unknown>;
  // Server sends a partial LocalPrefs snapshot. Merge it into the
  // local-prefs store so every browser tab stays in sync.
  (useLocalPrefs.getState().set as (patch: Record<string, unknown>) => void)(p);
}

// ── File operation handlers ──

export function handleFilesTree(msg: WSServerMessage) {
  const p = msg.payload as { root: string; tree: import('@/stores/file-store').TreeNode[]; error?: string | undefined };
  if (p.error) {
    useFileStore.getState().setError(p.error);
    return;
  }
  useFileStore.getState().setTree(p.root, p.tree);
}

export function handleFilesRead(msg: WSServerMessage) {
  const p = msg.payload as { filePath: string; content: string; error?: string | undefined };
  if (p.error) {
    useFileStore.getState().setError(p.error);
    return;
  }
  useFileStore.getState().openFile(p.filePath, p.content);
}

export function handleFilesWritten(msg: WSServerMessage) {
  const p = msg.payload as { filePath: string; success: boolean; error?: string | undefined };
  if (p.success) {
    useFileStore.getState().markSaved(p.filePath);
  } else if (p.error) {
    useFileStore.getState().setError(`Save failed: ${p.error}`);
  }
}

// ── Handler registry: maps message types to handler functions ──

/** Re-query the mailbox so the store (and ActivityBar badge) stays fresh. */
function queryMailbox() {
  const ws = getWSClient(useConfigStore.getState().wsUrl);
  ws?.send?.({ type: 'mailbox.messages', payload: { limit: 30 } });
  ws?.send?.({ type: 'mailbox.agents', payload: {} });
}

export const WS_HANDLERS: Record<string, (msg: WSServerMessage) => void> = {
  'session.start': (msg: WSServerMessage) => {
    handleSessionStart(msg);
    // Prime the mailbox store so the unread badge works before the panel
    // is ever opened.
    queryMailbox();
  },
  'context.debug': handleContextDebug,
  'key.operation_result': handleKeyOperationResult,
  'context.compacted': handleContextCompacted,
  'provider.response': handleProviderResponse,
  'context.repaired': handleContextRepaired,
  'session.end': handleSessionEnd,
  'iteration.started': handleIterationStarted,
  'provider.text_delta': handleTextDelta,
  'provider.thinking_delta': handleThinkingDelta,
  'tool.started': handleToolStarted,
  'tool.progress': handleToolProgress,
  'tool.executed': handleToolExecuted,
  'tool.confirm_needed': handleToolConfirmNeeded,
  'run.result': handleRunResult,
  'tools.list': handleToolsList,
  'memory.list': handleMemoryList,
  'skills.list': handleSkillsList,
  'diag.get': handleDiagGet,
  'stats.get': handleStatsGet,
  'todos.updated': handleTodosUpdated,
  'tasks.updated': (msg: WSServerMessage) => {
    // Handled directly by TasksPanel component via WS client.on()
  },
  'plan.updated': (msg: WSServerMessage) => {
    // Handled directly by PlanPanel component via WS client.on()
  },
  'modes.list': handleModesList,
  'context.modes.list': handleContextModesList,
  'context.mode.changed': handleContextModeChanged,
  'sessions.list': handleSessionsList,
  'error': handleError,
  'worktree.state': handleWorktreeState,
  'worktree.event': handleWorktreeEvent,
  'subagent.event': handleSubagentEvent,
  'fleet.concurrency_update': handleFleetConcurrency,
  'goal.updated': handleGoalUpdated,
  'prefs.updated': handlePrefsUpdated,
  'sessions.status_update': (msg: WSServerMessage) => {
    // Pipe to viz store — creates fleet:snapshot event for AgentFlowViz
    const vizEv = wsToVizEvent('sessions.status_update', msg.payload as Record<string, unknown>);
    if (vizEv) {
      useVizStore.getState().pushEvent(vizEv);
      useVizStore.getState().setActive(true);
    }
  },
  'files.tree': handleFilesTree,
  'files.read': handleFilesRead,
  'files.written': handleFilesWritten,
  'autophase.state': handleAutoPhaseState,
  'session.checkpoints': (msg: WSServerMessage) => {
    // Handled directly by CheckpointTimeline component via WS client.on()
  },
  'process.list': (msg: WSServerMessage) => {
    // Handled directly by ProcessMonitor component via WS client.on()
  },
  'projects.list': (msg: WSServerMessage) => {
    // Handled directly by ProjectsPanel component
  },
  'projects.added': (msg: WSServerMessage) => {
    // Handled directly by ProjectsPanel component
  },
  'projects.selected': (msg: WSServerMessage) => {
    // Handled directly by ProjectsPanel component
  },
  'mailbox.event': (msg: WSServerMessage) => {
    const vizEv = wsToVizEvent('mailbox.event', msg.payload as Record<string, unknown>);
    if (vizEv) {
      useVizStore.getState().pushEvent(vizEv);
      useVizStore.getState().setActive(true);
    }
    // Any mailbox activity invalidates the cached messages/agents.
    queryMailbox();
  },
  'mailbox.messages': (msg: WSServerMessage) => {
    const p = msg.payload as { messages?: MailboxMessage[] } | undefined;
    if (p?.messages) useMailboxStore.getState().setMessages(p.messages);
  },
  'mailbox.agents': (msg: WSServerMessage) => {
    const p = msg.payload as { agents?: MailboxAgent[] } | undefined;
    if (p?.agents) useMailboxStore.getState().setAgents(p.agents);
  },
  'mailbox.cleared': (_msg: WSServerMessage) => {
    // Clear the local message store and re-query so the UI stays consistent.
    useMailboxStore.getState().setMessages([]);
    queryMailbox();
  },
  'brain.status': (msg: WSServerMessage) => {
    const p = msg.payload as {
      maxAutoRisk: string;
      log: Array<{ at: number; kind: string; question: string; outcome: string }>;
    };
    const lines = [
      '🧠 **Brain** — policy → LLM decision chain',
      '',
      `Autonomy ceiling: \`${p.maxAutoRisk}\` _(change with \`/brain risk <off|low|medium|high|all>\`)_`,
    ];
    if (p.log.length === 0) {
      lines.push('', '_No decisions recorded yet this session._');
    } else {
      lines.push('', `Recent decisions (${p.log.length}):`);
      for (const entry of p.log.slice(-10)) {
        const ago = Math.max(0, Math.round((Date.now() - entry.at) / 1000));
        const age = ago < 60 ? `${ago}s` : ago < 3600 ? `${Math.round(ago / 60)}m` : `${Math.round(ago / 3600)}h`;
        const q = entry.question.length > 70 ? `${entry.question.slice(0, 67)}…` : entry.question;
        lines.push(`- \`${age} ago\` **${entry.kind}** — ${q}${entry.outcome ? ` → _${entry.outcome}_` : ''}`);
      }
    }
    useChatStore.getState().addMessage({ role: 'assistant', content: lines.join('\n') });
  },
  'brain.answer': (msg: WSServerMessage) => {
    const p = msg.payload as {
      question: string;
      decision: { type: string; text?: string; rationale?: string; reason?: string };
    };
    let content: string;
    if (p.decision.type === 'answer') {
      const rationale =
        p.decision.rationale && p.decision.rationale !== p.decision.text
          ? `\n\n_${p.decision.rationale}_`
          : '';
      content = `🧠 ${p.decision.text ?? ''}${rationale}`;
    } else if (p.decision.type === 'deny') {
      content = `🧠 Denied: ${p.decision.reason ?? ''}`;
    } else {
      content = '🧠 The Brain escalated this question back to you — it needs human judgement.';
    }
    useChatStore.getState().addMessage({ role: 'assistant', content });
  },
  'brain.event': (msg: WSServerMessage) => {
    const p = msg.payload as {
      event: string;
      intervened?: boolean;
      request?: { question?: string; source?: string; risk?: string };
      decision?: { type?: string; optionId?: string; text?: string; reason?: string; rationale?: string };
    };
    // Interventions are the headline: the Brain engaged on its own and
    // steered (or chose not to steer) the running agent. Surface them in
    // chat; everything else stays observable via toasts only when denied.
    if (p.event === 'brain.intervention') {
      const guidance = p.decision?.rationale ?? p.decision?.text ?? '';
      const headline = p.intervened
        ? '🧠 **Brain intervention** — corrective guidance was sent to the agent.'
        : '🧠 **Brain check** — a distress signal was reviewed; no action needed.';
      useChatStore.getState().addMessage({
        role: 'assistant',
        content: [headline, p.request?.question ?? '', guidance ? `_${guidance}_` : '']
          .filter(Boolean)
          .join('\n\n'),
      });
      if (p.intervened) toast.info('Brain intervened: agent steered');
    } else if (p.event === 'brain.decision_denied') {
      toast.warn(`Brain denied: ${p.decision?.reason ?? p.request?.question ?? 'request'}`);
    }
  },
  'working_dir.changed': (msg: WSServerMessage) => {
    const p = msg.payload as { cwd: string; projectRoot: string };
    useSessionStore.getState().setEnv({
      cwd: p.cwd,
      projectRoot: p.projectRoot,
      projectName: p.projectRoot.split(/[/\\]/).pop() || p.projectRoot,
    });
    // Re-fetch the file tree so the explorer shows the new working dir.
    useFileStore.getState().setTreeLoading(true);
    getWSClient().send({ type: 'files.tree', payload: { path: p.cwd } });
  },
  'model.refine_result': (msg: WSServerMessage) => {
    const p = msg.payload as { refined: string; english: string; error?: string | undefined };
    const refinePanel = useUIStore.getState().refinePanel;
    if (!refinePanel) return;
    if (p.error) {
      // Refinement failed — fall back to original
      toast.error(`Refinement failed: ${p.error}`);
      // Send the original message since refinement failed
      const { original } = refinePanel;
      useUIStore.getState().setRefinePanel(null);
      useChatStore.getState().addMessage({ role: 'user', content: original });
      useChatStore.getState().setLoading(true);
      getWSClient().send({ type: 'user_message', payload: { id: `msg_${Date.now()}`, content: original, timestamp: Date.now() } });
      return;
    }
    // TUI behavior: only show refine panel if result is actually different from original
    // If the model returned essentially the same text, send directly without showing panel
    const original = refinePanel.original;
    if (normalizedEqual(p.refined, original)) {
      useUIStore.getState().setRefinePanel(null);
      useChatStore.getState().addMessage({ role: 'user', content: original });
      useChatStore.getState().setLoading(true);
      getWSClient().send({ type: 'user_message', payload: { id: `msg_${Date.now()}`, content: original, timestamp: Date.now() } });
      return;
    }
    // Update the refine panel with the actual refined and english text
    useUIStore.getState().setRefinePanel({
      ...refinePanel,
      refined: p.refined,
      english: p.english,
    });
  },
};