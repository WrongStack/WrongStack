import { isActiveSessionMessage, pipeViz } from '@/lib/ws-client-utils';
import type { SideEffectEntry } from '@/stores';
import {
  type AgentTranscriptKind,
  type SessionHistoryEntry,
  useChatStore,
  useConfigStore,
  useFleetStore,
  useGoalAssessStore,
  useHistoryStore,
  useKanbanStore,
  useSddBoardStore,
  useSddWizardStore,
  useSessionStore,
  useSideEffectStore,
  useSpecsStore,
  extractActivitiesFromMessage,
  useCodemapActivityStore,
} from '@/stores';
import { useCodemapIndexStore } from '@/stores/codemap-index-store';
import type { WSServerMessage, WSGoalAssessResult } from '@/types';

// Chat domain handlers extracted to chat-handlers.ts
import {
  chatHandlerMap,
  handleToolExecuted,
  handleToolProgress,
  handleToolStarted,
} from './ws-handlers/chat-handlers.js';
// Coordinator domain handlers extracted to coordinator-handlers.ts
import { coordinatorHandlerMap } from './ws-handlers/coordinator-handlers.js';
// Files/mailbox domain handlers extracted to files-mailbox-handlers.ts
import { filesMailboxHandlerMap, queryMailbox } from './ws-handlers/files-mailbox-handlers.js';
// Fleet domain handlers extracted to fleet-handlers.ts
import { fleetHandlerMap } from './ws-handlers/fleet-handlers.js';
// Misc domain handlers extracted to misc-handlers.ts
import { miscHandlerMap, handleMemoryEvent } from './ws-handlers/misc-handlers.js';
import { techStackHandlerMap } from './ws-handlers/techstack-handlers.js';
// Session domain handlers extracted to session-handlers.ts
import {
  handleError as handleSessionDomainError,
  handleProviderResponse,
  handleSessionStart,
  sessionHandlerMap,
} from './ws-handlers/session-handlers.js';

// Re-export for backward compat (tests import WS_HANDLERS from this file)
export type { WSServerMessage } from '@/types';

// ── Session handlers ──

// ── Agent handlers ──

export function handleSessionEnd() {
  useConfigStore.getState().setWsConnected(false);
}

// ── Info / misc handlers ──

export function handleToolsList(msg: WSServerMessage) {
  const p = msg.payload as {
    tools: Array<{ name: string; description: string; params: string[] }>;
  };
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: [
      `🛠️ **Registered tools** (${p.tools.length})`,
      '',
      ...p.tools.map(
        (t) =>
          `• \`${t.name}\`${t.params.length ? ` (${t.params.join(', ')})` : ''} — ${t.description || '_no description_'}`,
      ),
    ].join('\n'),
  });
}

export function handleMemoryList(msg: WSServerMessage) {
  const p = msg.payload as { text: string; error?: string | undefined };
  const body = p.text?.trim();
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: p.error
      ? `Memory read failed: ${p.error}`
      : body
        ? `🧠 **Memory** \n\n${body}`
        : '🧠 **Memory** \n\n_empty — nothing remembered yet_',
  });
}

export function handleConfigDoctorResult(msg: WSServerMessage) {
  const p = msg.payload as {
    success: boolean;
    applied: boolean;
    changed: boolean;
    changes: Array<{ path: string; action: 'added' | 'replaced' }>;
    configPath: string;
    backupPath?: string | undefined;
    error?: string | undefined;
  };
  const chat = useChatStore.getState();
  if (!p.success) {
    chat.addMessage({
      role: 'assistant',
      content: `❌ **Config Doctor failed**\n\n${p.error ?? 'Unknown config error.'}`,
      isError: true,
    });
    return;
  }
  if (!p.changed) {
    chat.addMessage({
      role: 'assistant',
      content: `✅ **Config Doctor** — active profile config is healthy.\n\n\`${p.configPath}\``,
    });
    return;
  }

  const visible = p.changes.slice(0, 40);
  const lines = [
    p.applied
      ? `✅ **Config Doctor** — repaired ${p.changes.length} field(s).`
      : `🩺 **Config Doctor** — found ${p.changes.length} repairable field(s).`,
    '',
    ...visible.map(
      (change) =>
        `- \`${change.path}\` — ${change.action === 'added' ? 'missing default' : 'invalid shape; default required'}`,
    ),
  ];
  if (p.changes.length > visible.length) {
    lines.push(`- _…and ${p.changes.length - visible.length} more_`);
  }
  lines.push('', `Config: \`${p.configPath}\``);
  if (p.applied && p.backupPath) lines.push(`Backup: \`${p.backupPath}\``);
  if (!p.applied) lines.push('', 'Run `/doctor fix` to apply these repairs.');
  chat.addMessage({ role: 'assistant', content: lines.join('\n') });
}

// ── Sage response handlers ─────────────────────────────────────

export function handleMemorySageList(msg: WSServerMessage) {
  const p = msg.payload as {
    memories?: Array<{
      id: string;
      kind: string;
      status: string;
      text: string;
      tags: string[];
      createdAt: string;
    }>;
    stats?: {
      total: number;
      byStatus: Record<string, number>;
      byKind: Record<string, number>;
      edges: number;
    };
    error?: string | undefined;
  };
  if (p.error) {
    useChatStore.getState().addMessage({ role: 'assistant', content: `❌ ${p.error}` });
    return;
  }
  const memories = p.memories ?? [];
  const stats = p.stats;
  const lines: string[] = ['## 🧠 SAGE'];
  if (stats) {
    const active = stats.byStatus['active'] ?? 0;
    const stale = stats.byStatus['stale'] ?? 0;
    const archived = stats.byStatus['archived'] ?? 0;
    lines.push(
      `**Total:** ${stats.total} · Active: ${active} · Stale: ${stale} · Archived: ${archived} · Graph edges: ${stats.edges}`,
    );
    const kinds = Object.entries(stats.byKind)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${kind}=${count}`)
      .join(', ');
    if (kinds) lines.push(`**Kinds:** ${kinds}`);
    lines.push('');
  }
  if (memories.length === 0) {
    lines.push('_No entries to display._');
  } else {
    for (const mem of memories.slice(0, 20)) {
      const preview = mem.text.length > 80 ? `${mem.text.slice(0, 78)}…` : mem.text;
      const tags = mem.tags.length > 0 ? mem.tags.map((t) => `\`${t}\``).join(' ') : '';
      const date = mem.createdAt.slice(0, 10);
      lines.push(
        `- \`${mem.id.slice(0, 12)}…\` [${mem.kind}|${mem.status}] ${date} — ${preview}${tags ? ` ${tags}` : ''}`,
      );
    }
    if (memories.length > 20) lines.push(`_…and ${memories.length - 20} more_`);
  }
  lines.push('');
  lines.push('*Use `/memory` in the TUI or build a Memory Manager panel for full editing.*');
  useChatStore.getState().addMessage({ role: 'assistant', content: lines.join('\n') });
}

export function handleMemorySageGet(msg: WSServerMessage) {
  const p = msg.payload as {
    memory?: {
      id: string;
      kind: string;
      status: string;
      text: string;
      tags: string[];
      createdAt: string;
      updatedAt: string;
      importance: number;
      confidence: number;
      anchors: Array<{ type: string; path?: string }>;
    };
    error?: string | undefined;
  };
  if (p.error) {
    useChatStore.getState().addMessage({ role: 'assistant', content: `❌ ${p.error}` });
    return;
  }
  if (!p.memory) {
    useChatStore.getState().addMessage({ role: 'assistant', content: '❌ Memory not found.' });
    return;
  }
  const m = p.memory;
  const tags = m.tags.length > 0 ? m.tags.map((t) => `\`${t}\``).join(' ') : '—';
  const anchors = m.anchors.length > 0 ? m.anchors.map((a) => a.path ?? a.type).join(', ') : '—';
  const lines = [
    `## 🧠 Memory: \`${m.id}\``,
    '',
    `**Text:** ${m.text}`,
    `**Kind:** \`${m.kind}\` · **Status:** \`${m.status}\``,
    `**Created:** ${m.createdAt.slice(0, 10)} · **Updated:** ${m.updatedAt.slice(0, 10)}`,
    `**Importance:** ${m.importance} · **Confidence:** ${m.confidence}`,
    `**Tags:** ${tags}`,
    `**Anchors:** ${anchors}`,
  ];
  useChatStore.getState().addMessage({ role: 'assistant', content: lines.join('\n') });
}

export function handleMemorySageUpdate(msg: WSServerMessage) {
  const p = msg.payload as { memory?: Record<string, unknown>; error?: string | undefined };
  if (p.error) {
    useChatStore
      .getState()
      .addMessage({ role: 'assistant', content: `❌ Update failed: ${p.error}` });
    return;
  }
  if (p.memory) {
    const id = String(p.memory['id'] ?? '');
    useChatStore
      .getState()
      .addMessage({ role: 'assistant', content: `✅ Memory \`${id}\` updated.` });
  }
}

export function handleMemorySageRemember(msg: WSServerMessage) {
  const p = msg.payload as { memory?: Record<string, unknown>; error?: string | undefined };
  if (p.error) {
    useChatStore
      .getState()
      .addMessage({ role: 'assistant', content: `❌ Failed to create memory: ${p.error}` });
    return;
  }
  if (p.memory) {
    const id = String(p.memory['id'] ?? '');
    useChatStore
      .getState()
      .addMessage({ role: 'assistant', content: `✅ Memory \`${id}\` created.` });
  }
}

export function handleMemorySageRecover(msg: WSServerMessage) {
  const p = msg.payload as {
    memory?: Record<string, unknown>;
    noop?: boolean;
    activeId?: string;
    error?: string | undefined;
  };
  const chat = useChatStore.getState();
  if (p.error) {
    chat.addMessage({ role: 'assistant', content: `❌ Recover failed: ${p.error}` });
    return;
  }
  if (!p.memory) return;
  const id = String(p.memory['id'] ?? '');
  if (p.noop) {
    // Already active, or superseded — `activeId` is the head of the chain.
    const target = p.activeId ?? id;
    chat.addMessage({
      role: 'assistant',
      content: `ℹ️ Nothing to recover — \`${target}\` is already the active version.`,
    });
    return;
  }
  chat.addMessage({ role: 'assistant', content: `✅ Memory \`${id}\` recovered.` });
}

export function handleMemorySageCandidateResolve(msg: WSServerMessage) {
  const p = msg.payload as {
    candidate?: { id: string; status: string };
    resolvedAction?: 'accept' | 'reject';
    error?: string | undefined;
  };
  const chat = useChatStore.getState();
  if (p.error) {
    chat.addMessage({ role: 'assistant', content: `❌ Candidate resolve failed: ${p.error}` });
    return;
  }
  if (!p.candidate) return;
  const verb = p.resolvedAction === 'reject' ? 'rejected' : 'accepted';
  chat.addMessage({
    role: 'assistant',
    content: `✅ Candidate \`${p.candidate.id}\` ${verb}.`,
  });
}

export function handleMemorySageBackfillRecoverable(msg: WSServerMessage) {
  const p = msg.payload as {
    examined?: number;
    recovered?: number;
    recoverable?: number;
    dryRun?: boolean;
    error?: string | undefined;
  };
  const chat = useChatStore.getState();
  if (p.error) {
    chat.addMessage({ role: 'assistant', content: `❌ Backfill failed: ${p.error}` });
    return;
  }
  const summary = `examined ${p.examined ?? 0} · recoverable ${p.recoverable ?? 0} · recovered ${p.recovered ?? 0}`;
  chat.addMessage({
    role: 'assistant',
    content: p.dryRun
      ? `ℹ️ Backfill preview (dry-run) — ${summary}. Re-run with apply to write.`
      : `✅ Backfill applied — ${summary}.`,
  });
}

export function handleSkillsList(msg: WSServerMessage) {
  const p = msg.payload as {
    enabled: boolean;
    error?: string | undefined;
    skills: Array<{
      name: string;
      description: string;
      version: string;
      source: string;
      path: string;
      trigger: string;
      scope: string[];
    }>;
  };
  if (!p.enabled) {
    useChatStore.getState().addMessage({
      role: 'assistant',
      content: '🎯 **Skills** \n\n_disabled (config.features.skills = false)_',
    });
    return;
  }
  const lines = [
    `🎯 **Skills** (${p.skills.length})`,
    '',
    ...(p.skills.length === 0
      ? ['_none registered_']
      : p.skills.map(
          (s) =>
            `• \`${s.name}\`${s.version ? ` v${s.version}` : ''} _(${s.source})_ — ${s.description || s.trigger || '_no description_'}`,
        )),
  ];
  if (p.error) lines.push('', `⚠ ${p.error}`);
  useChatStore.getState().addMessage({ role: 'assistant', content: lines.join('\n') });
}

export function handleDiagGet(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as {
    provider: string;
    model: string;
    cwd: string;
    sessionId: string;
    tools: { count: number; names: string[] };
    maxTools: number;
    droppedTools: number;
    features: { memory: boolean; skills: boolean; modelsRegistry: boolean };
    mode: string;
    usage: { input: number; output: number; cacheRead?: number | undefined };
    messages: number;
    todos: number;
  };
  // Store the dropped count for the status-bar chip (reactive).
  // Defense-in-depth: guard against maxTools=0 (no limit) even though
  // the server already sends droppedTools=0 in that case.
  useSessionStore.getState().setDroppedTools((p.maxTools ?? 0) > 0 ? (p.droppedTools ?? 0) : 0);
  useChatStore.getState().addMessage({
    role: 'assistant',
    content: [
      '🩺 **Runtime diagnostics**',
      '',
      `**Provider:** \`${p.provider}\` / \`${p.model}\``,
      `**Mode:** \`${p.mode}\``,
      `**Session:** \`${p.sessionId}\``,
      `**CWD:** \`${p.cwd}\``,
      '',
      `**Tools:** ${p.tools.count}`,
      `**Messages:** ${p.messages}  ·  **Todos:** ${p.todos}`,
      `**Usage:** ${p.usage.input.toLocaleString()} in · ${p.usage.output.toLocaleString()} out${p.usage.cacheRead ? ` · ${p.usage.cacheRead.toLocaleString()} cache` : ''}`,
      '',
      `**Features:** memory=${p.features.memory ? '✓' : '✗'} · skills=${p.features.skills ? '✓' : '✗'} · modelsRegistry=${p.features.modelsRegistry ? '✓' : '✗'}`,
    ].join('\n'),
  });
}

export function handleStatsGet(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as {
    sessionId: string;
    provider: string;
    model: string;
    usage: {
      input: number;
      output: number;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    };
    cache:
      | {
          readTokens: number;
          writeTokens: number;
          hitRatio: number;
          providers?: Array<{
            provider: string;
            input: number;
            cacheRead: number;
            cacheWrite: number;
            hitRatio: number;
          }>;
        }
      | null;
    currentRequest?: { input: number; cacheRead: number; cacheWrite: number } | undefined;
    cost: number;
    messages: number;
    readFiles: number;
    tools: number;
    sideEffectCount?: number | undefined;
    elapsedMs: number;
  };
  const elapsedSec = Math.floor(p.elapsedMs / 1000);
  const elapsed =
    elapsedSec < 60
      ? `${elapsedSec}s`
      : elapsedSec < 3600
        ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
        : `${Math.floor(elapsedSec / 3600)}h ${Math.floor((elapsedSec % 3600) / 60)}m`;

  // Live cache snapshot — drives the topbar cache badge and the
  // ContextBreakdownModal coverage bar. `currentRequest.cacheRead` is
  // the cached prefix of the most recent prompt (per-request), capped
  // at the live request size so the coverage figure never overshoots
  // what was actually sent. `usage.cacheRead` would be cumulative and
  // misleading here. `null` clears the field when the server reports
  // no cache yet.
  const lastInputTokens = useSessionStore.getState().lastInputTokens;
  const currentRequestCacheRead = p.currentRequest?.cacheRead ?? 0;
  useSessionStore.getState().setCacheStats(
    p.cache
      ? {
          readTokens: p.cache.readTokens,
          writeTokens: p.cache.writeTokens,
          hitRatio: p.cache.hitRatio,
          providers: p.cache.providers ?? [],
          coverageTokens: Math.max(0, Math.min(lastInputTokens, currentRequestCacheRead)),
        }
      : null,
  );

  useChatStore.getState().addMessage({
    role: 'assistant',
    content: [
      '📈 **Session stats**',
      '',
      `**Session:** \`${p.sessionId}\``,
      `**Provider/Model:** \`${p.provider}\` / \`${p.model}\``,
      `**Elapsed:** ${elapsed}`,
      '',
      `**Usage:** ${p.usage.input.toLocaleString()} in · ${p.usage.output.toLocaleString()} out`,
      ...(p.cache && p.cache.readTokens > 0
        ? [
            `**Cache:** ${p.cache.readTokens.toLocaleString()} read · ${p.cache.writeTokens.toLocaleString()} write · hit ratio ${(p.cache.hitRatio * 100).toFixed(1)}%`,
          ]
        : []),
      `**Cost:** ${p.cost.toFixed(4)}`,
      '',
      `**Messages:** ${p.messages}  ·  **Files read:** ${p.readFiles}  ·  **Tools available:** ${p.tools}`,
      ...(p.sideEffectCount ? [`**Side effects:** ⚠ ${p.sideEffectCount}`] : []),
    ].join('\n'),
  });
}

export function handleTodosUpdated(msg: WSServerMessage) {
  if (!isActiveSessionMessage(msg)) return;
  const p = msg.payload as {
    todos: Array<{
      id: string;
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
      activeForm?: string | undefined;
      /** Board-derived titles of the unfinished work this row waits on. */
      blockedBy?: string[] | undefined;
      kanbanBoardId?: string | undefined;
      kanbanTaskId?: string | undefined;
    }>;
  };
  useSessionStore.getState().setTodos(p.todos ?? []);
}

export function handleModesList(msg: WSServerMessage) {
  const p = msg.payload as {
    modes: Array<{ id: string; name: string; description: string; isActive: boolean }>;
    activeId: string;
  };
  useSessionStore
    .getState()
    .setModes(p.modes.map((m) => ({ id: m.id, name: m.name, description: m.description })));
  useSessionStore.getState().setEnv({ mode: p.activeId });
}

export function handleContextModesList(msg: WSServerMessage) {
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

function handleKanbanResult(msg: WSServerMessage) {
  useKanbanStore
    .getState()
    .handleResult(msg.type, msg.payload as import('@/stores').KanbanResultPayload);
}

/**
 * Type-safe handler map. Keyed by `WSServerMessage['type']` — a typo'd key
 * or a handler for an unknown server message type now fails at compile time.
 * Each handler receives the wide `WSServerMessage` (the dispatcher only
 * guarantees the type matches the key, not the payload narrowing), so the
 * individual handlers still do their own payload shaping. The win is key
 * safety + forcing every handler to be a (msg) => void.
 */
export const WS_HANDLERS: Partial<Record<WSServerMessage['type'], (msg: WSServerMessage) => void>> =
  {
    ...chatHandlerMap,
    ...sessionHandlerMap,
    ...fleetHandlerMap,
    ...filesMailboxHandlerMap,
    ...miscHandlerMap,
    ...coordinatorHandlerMap,
    ...techStackHandlerMap,
    'config.doctor.result': handleConfigDoctorResult,
    'session.start': (msg: WSServerMessage) => {
      handleSessionStart(msg);
      queryMailbox();
    },
    'specs.list': (msg: WSServerMessage) => {
      const p = msg.payload as { specs?: import('@/stores/specs-store').SpecListItem[] };
      useSpecsStore.getState().setSpecs(p.specs ?? []);
    },
    'specs.detail': (msg: WSServerMessage) => {
      useSpecsStore
        .getState()
        .setDetail(msg.payload as unknown as import('@/stores/specs-store').SpecDetail);
    },
    'sdd.board.snapshot': (msg: WSServerMessage) => {
      useSddBoardStore
        .getState()
        .setSnapshot(
          msg.payload as unknown as import('@/stores/sdd-board-store').SddBoardSnapshotUI,
        );
    },
    'sdd.board.list': (msg: WSServerMessage) => {
      const p = msg.payload as { boards?: import('@/stores/sdd-board-store').SddBoardSummary[] };
      useSddBoardStore.getState().setBoards(p.boards ?? []);
    },
    'sdd.board.lifecycle_result': (msg: WSServerMessage) => {
      const p = msg.payload as Omit<import('@/stores/sdd-board-store').SddLifecycleResultUI, 'at'>;
      const store = useSddBoardStore.getState();
      store.setLifecycleResult({ ...p, at: Date.now() });
      store.setDestroying(false);
      // Destroy wipes interview + specs + mirrors — clear the wizard UI too.
      if (p.op === 'destroy' && p.ok) {
        useSddWizardStore.getState().reset();
      }
    },
    'sdd.spec.snapshot': (msg: WSServerMessage) => {
      useSddWizardStore
        .getState()
        .setSnapshot(
          msg.payload as unknown as import('@/stores/sdd-wizard-store').SddWizardSnapshot,
        );
    },
    'sdd.spec.agent_text': (msg: WSServerMessage) => {
      useSddWizardStore.getState().setAgentText((msg.payload as { text?: string }).text ?? '');
    },
    'sdd.spec.error': (msg: WSServerMessage) => {
      useSddWizardStore
        .getState()
        .setError((msg.payload as { message?: string }).message ?? 'Error');
    },
    'sdd.run.started': (msg: WSServerMessage) => {
      useSddWizardStore
        .getState()
        .setStartedRunId((msg.payload as { runId?: string }).runId ?? null);
    },
    'goal.assess.result': (msg: WSServerMessage) => {
      const p = msg.payload as WSGoalAssessResult['payload'];
      useGoalAssessStore.getState().setResult({
        realistic: p.realistic,
        durationClaimed: p.durationClaimed,
        explanation: p.explanation,
        recommendedDuration: p.recommendedDuration,
        concerns: p.concerns,
        parseFailed: p.parseFailed,
        parseError: p.parseError,
        reqSeq: p.reqSeq ?? 0,
      });
    },
    'kanban.list': handleKanbanResult,
    'kanban.get': handleKanbanResult,
    'kanban.health': handleKanbanResult,
    'kanban.workbench': handleKanbanResult,
    'kanban.create': handleKanbanResult,
    'kanban.duplicate': handleKanbanResult,
    'kanban.update': handleKanbanResult,
    'kanban.delete': handleKanbanResult,
    'kanban.generate': handleKanbanResult,
    'kanban.snapshot': handleKanbanResult,
    'kanban.taskgraph.export': handleKanbanResult,
    'kanban.taskgraph.sync': handleKanbanResult,
    'kanban.task.ready': handleKanbanResult,
    'kanban.task.add': handleKanbanResult,
    'kanban.task.split': handleKanbanResult,
    'kanban.task.merge': handleKanbanResult,
    'kanban.task.update': handleKanbanResult,
    'kanban.task.move': handleKanbanResult,
    'kanban.task.copy': handleKanbanResult,
    'kanban.task.transfer': handleKanbanResult,
    'kanban.task.transition': handleKanbanResult,
    'kanban.task.chain': handleKanbanResult,
    'kanban.task.chain.get': handleKanbanResult,
    'kanban.task.claim': handleKanbanResult,
    'kanban.task.release': handleKanbanResult,
    'kanban.task.metric.add': handleKanbanResult,
    'kanban.task.metric.update': handleKanbanResult,
    'kanban.task.check.add': handleKanbanResult,
    'kanban.task.check.update': handleKanbanResult,
    'kanban.task.note.add': handleKanbanResult,
    'kanban.task.assign': handleKanbanResult,
    'kanban.task.dispatch': handleKanbanResult,
    'kanban.task.remove': handleKanbanResult,
    'kanban.task.get': handleKanbanResult,
    'kanban.board.history': handleKanbanResult,
    'kanban.run.start': handleKanbanResult,
    'kanban.supervisor.status': handleKanbanResult,
    'kanban.supervisor.audit': handleKanbanResult,
    'kanban.task.verify': handleKanbanResult,
    'kanban.task.verification_started': handleKanbanResult,
    'kanban.task.verification_completed': handleKanbanResult,
    'kanban.decomposition.approve': handleKanbanResult,
    'kanban.decomposition.reject': handleKanbanResult,
    'kanban.decomposition.resolved': handleKanbanResult,
    'kanban.decomposition.applied': handleKanbanResult,
    'tools.list': handleToolsList,
    'memory.list': handleMemoryList,
    'memory.sage.list': handleMemorySageList,
    'memory.sage.get': handleMemorySageGet,
    'memory.sage.update': handleMemorySageUpdate,
    'memory.sage.remember': handleMemorySageRemember,
    'memory.sage.recover': handleMemorySageRecover,
    'memory.sage.candidateResolve': handleMemorySageCandidateResolve,
    'memory.sage.backfillRecoverable': handleMemorySageBackfillRecoverable,
    'skills.list': handleSkillsList,
    'diag.get': handleDiagGet,
    'stats.get': handleStatsGet,
    side_effects: (msg: WSServerMessage) => {
      if (!isActiveSessionMessage(msg)) return;
      const p = msg.payload as { sideEffects?: SideEffectEntry[] };
      useSideEffectStore.getState().setSideEffects(p.sideEffects ?? []);
    },
    'todos.updated': handleTodosUpdated,
    // The standalone server broadcasts `todos.cleared` on clear (the CLI server
    // sends `todos.updated` with an empty list); handle both so the worklist
    // empties in the UI regardless of which server is driving.
    'todos.cleared': (_msg: WSServerMessage) => {
      if (!isActiveSessionMessage(_msg)) return;
      useSessionStore.getState().setTodos([]);
    },
    'agent.timeline.message': (msg: WSServerMessage) => {
      if (!isActiveSessionMessage(msg)) return;
      const p = msg.payload as {
        subagentId: string;
        agentName: string;
        content: string;
        kind: string;
        iteration: number;
        ts: string;
        toolName?: string;
        toolOk?: boolean;
        costUsd?: number;
      };
      useFleetStore.getState().pushAgentTimelineEntry({
        subagentId: p.subagentId,
        agentName: p.agentName,
        content: p.content,
        kind: p.kind as AgentTranscriptKind,
        iteration: p.iteration,
        ts: p.ts,
        toolName: p.toolName,
        toolOk: p.toolOk,
        costUsd: p.costUsd,
      });
    },
    'agent.status_changed': (msg: WSServerMessage) => {
      if (!isActiveSessionMessage(msg)) return;
      const p = msg.payload as {
        subagentId: string;
        agentName: string;
        status: string;
        ts: string;
        summary?: string;
        task?: string;
      };
      useFleetStore.getState().pushAgentTimelineEntry({
        subagentId: p.subagentId,
        agentName: p.agentName,
        content: p.summary ?? p.status,
        kind: 'status',
        iteration: 0,
        ts: p.ts,
        status: p.status,
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
      // Legacy server response. Project switching/registering is no longer a WebUI surface.
    },
    'projects.added': (_msg: WSServerMessage) => {
      // Legacy server response. Project switching/registering is no longer a WebUI surface.
    },
    'projects.selected': (_msg: WSServerMessage) => {
      // Legacy server response. Project switching/registering is no longer a WebUI surface.
    },
    'tool.disabled': (_msg: WSServerMessage) => {
      // SettingsPanel/ToolsSection listens on the raw message stream and refreshes tools.list.
    },
    'tool.enabled': (_msg: WSServerMessage) => {
      // SettingsPanel/ToolsSection listens on the raw message stream and refreshes tools.list.
    },
    // ── CodeMap activity overlay ──────────────────────────────────────────
    // Tool lifecycle drives active agent presence. Filesystem watcher events
    // confirm mutations (or surface deterministic/external writes that did not
    // pass through ToolExecutor at all).
    // IMPORTANT: these compose with — not replace — the existing handlers from
    // sessionHandlerMap/miscHandlerMap. We call the original first, then record.
    'provider.response': (msg: WSServerMessage) => {
      handleProviderResponse(msg);
    },
    'tool.progress': (msg: WSServerMessage) => {
      handleToolProgress(msg);
      const activities = extractActivitiesFromMessage(msg);
      const store = useCodemapActivityStore.getState();
      for (const activity of activities) store.recordFileEvent(activity);
    },
    'tool.started': (msg: WSServerMessage) => {
      handleToolStarted(msg);
      const activities = extractActivitiesFromMessage(msg);
      if (activities.length > 0) {
        useCodemapActivityStore.getState().startActivities(activities);
      }
    },
    'tool.executed': (msg: WSServerMessage) => {
      handleToolExecuted(msg);
      const payload = msg.payload as {
        id?: string | undefined;
        durationMs?: number | undefined;
        ok?: boolean | undefined;
      };
      if (payload.id) {
        useCodemapActivityStore.getState().finishTool(payload.id, {
          durationMs: payload.durationMs,
          ok: payload.ok !== false,
        });
      }
    },
    'codemap.tool_started': (msg: WSServerMessage) => {
      pipeViz(msg);
      const activities = extractActivitiesFromMessage(msg);
      if (activities.length > 0) {
        useCodemapActivityStore.getState().startActivities(activities);
      }
    },
    'codemap.tool_executed': (msg: WSServerMessage) => {
      pipeViz(msg);
      const payload = msg.payload as {
        id?: string | undefined;
        durationMs?: number | undefined;
        ok?: boolean | undefined;
      };
      if (payload.id) {
        useCodemapActivityStore.getState().finishTool(payload.id, {
          durationMs: payload.durationMs,
          ok: payload.ok !== false,
        });
      }
    },
    'codemap.file_event': (msg: WSServerMessage) => {
      const activities = extractActivitiesFromMessage(msg);
      const store = useCodemapActivityStore.getState();
      for (const activity of activities) store.recordFileEvent(activity);
    },
    'codemap.index_updated': (msg: WSServerMessage) => {
      const payload = msg.payload as { at?: number } | undefined;
      useCodemapIndexStore.getState().notifyIndexUpdated(payload?.at);
    },
    'file.saved': (msg: WSServerMessage) => {
      const activities = extractActivitiesFromMessage(msg);
      if (activities.length > 0) {
        const store = useCodemapActivityStore.getState();
        for (const activity of activities) store.recordFileEvent(activity);
      }
    },
    'memory.event': (msg: WSServerMessage) => {
      handleMemoryEvent(msg);
      const activities = extractActivitiesFromMessage(msg);
      if (activities.length > 0) {
        const store = useCodemapActivityStore.getState();
        for (const a of activities) store.recordActivity(a);
      }
    },
  };
