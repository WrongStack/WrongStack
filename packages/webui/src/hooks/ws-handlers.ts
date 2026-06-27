import { type SessionHistoryEntry, useChatStore, useConfigStore, useFleetStore, useHistoryStore, useSessionStore, useSpecsStore, useSddBoardStore, useSddWizardStore } from '@/stores';
import type { WSServerMessage } from '@/types';

// Chat domain handlers extracted to chat-handlers.ts
import { chatHandlerMap } from './ws-handlers/chat-handlers.js';
// Session domain handlers extracted to session-handlers.ts
import {
  sessionHandlerMap,
  handleSessionStart,
  handleError as handleSessionDomainError,
} from './ws-handlers/session-handlers.js';
// Fleet domain handlers extracted to fleet-handlers.ts
import { fleetHandlerMap } from './ws-handlers/fleet-handlers.js';
// Files/mailbox domain handlers extracted to files-mailbox-handlers.ts
import { filesMailboxHandlerMap, queryMailbox } from './ws-handlers/files-mailbox-handlers.js';
// Misc domain handlers extracted to misc-handlers.ts
import { miscHandlerMap } from './ws-handlers/misc-handlers.js';
// Coordinator domain handlers extracted to coordinator-handlers.ts
import { coordinatorHandlerMap } from './ws-handlers/coordinator-handlers.js';

// Re-export for backward compat (tests import WS_HANDLERS from this file)
export type { WSServerMessage } from '@/types';

// ── Session handlers ──

// ── Agent handlers ──

export function handleSessionEnd() {
  useConfigStore.getState().setWsConnected(false);
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
  handleSessionDomainError(msg);
}

export const WS_HANDLERS: Record<string, (msg: WSServerMessage) => void> = {
  ...chatHandlerMap,
  ...sessionHandlerMap,
  ...fleetHandlerMap,
  ...filesMailboxHandlerMap,
  ...miscHandlerMap,
  ...coordinatorHandlerMap,
  'session.start': (msg: WSServerMessage) => {
    handleSessionStart(msg);
    queryMailbox();
  },
  'specs.list': (msg: WSServerMessage) => {
    const p = msg.payload as { specs?: import('@/stores/specs-store').SpecListItem[] };
    useSpecsStore.getState().setSpecs(p.specs ?? []);
  },
  'specs.detail': (msg: WSServerMessage) => {
    useSpecsStore.getState().setDetail(msg.payload as unknown as import('@/stores/specs-store').SpecDetail);
  },
  'sdd.board.snapshot': (msg: WSServerMessage) => {
    useSddBoardStore.getState().setSnapshot(
      msg.payload as unknown as import('@/stores/sdd-board-store').SddBoardSnapshotUI,
    );
  },
  'sdd.board.list': (msg: WSServerMessage) => {
    const p = msg.payload as { boards?: import('@/stores/sdd-board-store').SddBoardSummary[] };
    useSddBoardStore.getState().setBoards(p.boards ?? []);
  },
  'sdd.spec.snapshot': (msg: WSServerMessage) => {
    useSddWizardStore.getState().setSnapshot(
      msg.payload as unknown as import('@/stores/sdd-wizard-store').SddWizardSnapshot,
    );
  },
  'sdd.spec.agent_text': (msg: WSServerMessage) => {
    useSddWizardStore.getState().setAgentText((msg.payload as { text?: string }).text ?? '');
  },
  'sdd.spec.error': (msg: WSServerMessage) => {
    useSddWizardStore.getState().setError((msg.payload as { message?: string }).message ?? 'Error');
  },
  'sdd.run.started': (msg: WSServerMessage) => {
    useSddWizardStore.getState().setStartedRunId((msg.payload as { runId?: string }).runId ?? null);
  },
  'tools.list': handleToolsList,
  'memory.list': handleMemoryList,
  'skills.list': handleSkillsList,
  'diag.get': handleDiagGet,
  'stats.get': handleStatsGet,
  'todos.updated': handleTodosUpdated,
  // The standalone server broadcasts `todos.cleared` on clear (the CLI server
  // sends `todos.updated` with an empty list); handle both so the worklist
  // empties in the UI regardless of which server is driving.
  'todos.cleared': (_msg: WSServerMessage) => {
    useSessionStore.getState().setTodos([]);
  },
  'agent.timeline.message': (msg: WSServerMessage) => {
    const p = msg.payload as {
      subagentId: string; agentName: string; content: string;
      kind: string; iteration: number; ts: string;
      toolName?: string; costUsd?: number;
    };
    useFleetStore.getState().pushAgentTimelineEntry({
      subagentId: p.subagentId, agentName: p.agentName,
      content: p.content.slice(0, 200), kind: p.kind,
      iteration: p.iteration, ts: p.ts, toolName: p.toolName,
    });
  },
  'agent.status_changed': (msg: WSServerMessage) => {
    const p = msg.payload as {
      subagentId: string; agentName: string; status: string;
      ts: string; summary?: string; task?: string;
    };
    useFleetStore.getState().pushAgentTimelineEntry({
      subagentId: p.subagentId, agentName: p.agentName,
      content: p.summary ?? p.status, kind: 'status',
      iteration: 0, ts: p.ts, status: p.status,
    });
  },
  'tasks.updated': (_msg: WSServerMessage) => {
    // Handled directly by TasksPanel component via WS client.on()
  },
  'plan.updated': (_msg: WSServerMessage) => {
    // Handled directly by PlanPanel component via WS client.on()
  },
  'modes.list': handleModesList,
  'session.checkpoints': (_msg: WSServerMessage) => {
    // Handled directly by CheckpointTimeline component via WS client.on()
  },
  'process.list': (_msg: WSServerMessage) => {
    // Handled directly by ProcessMonitor component via WS client.on()
  },
  'projects.list': (_msg: WSServerMessage) => {
    // Handled directly by ProjectsPanel component
  },
  'projects.added': (_msg: WSServerMessage) => {
    // Handled directly by ProjectsPanel component
  },
  'projects.selected': (_msg: WSServerMessage) => {
    // Handled directly by ProjectsPanel component
  },
  'prompts.search': (_msg: WSServerMessage) => {
    // Reserved for server-side prompt search; the current modal filters its
    // loaded prompt list locally.
  },
  'prompts.created': (_msg: WSServerMessage) => {
    // Fire-and-forget acknowledgement for future prompt creation UI.
  },
  'prompts.favorite': (_msg: WSServerMessage) => {
    // PromptLibraryModal updates favorite state optimistically.
  },
  'prompts.used': (_msg: WSServerMessage) => {
    // Best-effort usage telemetry acknowledgement.
  },
  'design.state': (_msg: WSServerMessage) => {
    // Design panels hydrate from design.list/design.use/design.set.
  },
};
