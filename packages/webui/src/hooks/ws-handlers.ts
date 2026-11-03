import { applyAtlasFrame } from '@wrongstack/project-surfaces/atlas/frames';
import { messageSessionId, pipeViz, sessionFor } from '@/lib/ws-client-utils';
import type { SideEffectEntry } from '@/stores';
import {
  type AgentTranscriptKind,
  extractActivitiesFromMessage,
  type SessionHistoryEntry,
  useCodemapActivityStore,
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
} from '@/stores';
import type { WSGoalAssessResult, WSServerMessage } from '@/types';
import {
  handleMemoryList,
  handleMemorySageBackfillRecoverable,
  handleMemorySageCandidateResolve,
  handleMemorySageGet,
  handleMemorySageList,
  handleMemorySageRecover,
  handleMemorySageRemember,
  handleMemorySageUpdate,
} from './ws-memory-handlers.js';
import { replyLane, replyMeta } from './ws-reply-lanes.js';

export {
  handleMemoryList,
  handleMemorySageBackfillRecoverable,
  handleMemorySageCandidateResolve,
  handleMemorySageGet,
  handleMemorySageList,
  handleMemorySageRecover,
  handleMemorySageRemember,
  handleMemorySageUpdate,
} from './ws-memory-handlers.js';

// Chat domain handlers extracted to chat-handlers.ts
import {
  chatHandlerMap,
  handleToolExecuted,
  handleToolProgress,
  handleToolStarted,
} from './ws-handlers/chat-handlers.js';
// Coordinator domain handlers extracted to coordinator-handlers.ts
import { coordinatorHandlerMap } from './ws-handlers/coordinator-handlers.js';
import {
  handleConfigDoctorResult,
  handleDiagGet,
  handleSkillsList,
  handleStatsGet,
} from './ws-handlers/diagnostics-handlers.js';
// Files/mailbox domain handlers extracted to files-mailbox-handlers.ts
import { filesMailboxHandlerMap, queryMailbox } from './ws-handlers/files-mailbox-handlers.js';
// Fleet domain handlers extracted to fleet-handlers.ts
import { fleetHandlerMap } from './ws-handlers/fleet-handlers.js';
// Misc domain handlers extracted to misc-handlers.ts
import {
  handleMcpServerDisconnected,
  handleMcpServerUp,
} from './ws-handlers/mcp-status-handlers.js';
import { handleMemoryEvent, miscHandlerMap } from './ws-handlers/misc-handlers.js';
import { promptQueueHandlerMap, requestPromptQueue } from './ws-handlers/prompt-queue-handlers.js';
// Session domain handlers extracted to session-handlers.ts
import {
  handleProviderResponse,
  handleError as handleSessionDomainError,
  handleSessionStart,
  sessionHandlerMap,
} from './ws-handlers/session-handlers.js';
import { techStackHandlerMap } from './ws-handlers/techstack-handlers.js';

// Re-export for backward compat (tests import WS_HANDLERS from this file)
export type { WSServerMessage } from '@/types';
export {
  handleConfigDoctorResult,
  handleDiagGet,
  handleSkillsList,
  handleStatsGet,
} from './ws-handlers/diagnostics-handlers.js';

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
  replyLane(msg).addMessage({
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

export function handleBrowserPolicyResult(msg: WSServerMessage) {
  const p = msg.payload as { message?: string; ok?: boolean };
  replyLane(msg).addMessage({
    role: 'assistant',
    content: ['```', p.message ?? '', '```'].join('\n'),
    ...(p.ok === false ? { isError: true } : {}),
  });
}

export function handleTodosUpdated(msg: WSServerMessage) {
  // A tab's worklist belongs to that tab. Dropping a background session's
  // update left its todo list frozen at whatever it held when you looked away,
  // so the frame routes to the lane it names. But it must NOT fall back to the
  // lane in front either: `todos.updated` is always session-scoped, so an
  // untagged frame is a server stamping bug — and writing it into the active
  // lane is how another tab's board surfaced in this tab's worklist mid-update.
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
  const lane = sessionFor(msg);
  if (!lane) return;
  lane.setTodos(p.todos ?? []);
}

export function handleModesList(msg: WSServerMessage) {
  const p = msg.payload as {
    modes: Array<{ id: string; name: string; description: string; isActive: boolean }>;
    activeId: string;
  };
  useSessionStore
    .getState()
    .setModes(p.modes.map((m) => ({ id: m.id, name: m.name, description: m.description })));
  replyMeta(msg).setEnvRates({ mode: p.activeId });
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
  replyMeta(msg).setEnvRates({ contextMode: p.activeId });
}

export function handleContextModeChanged(msg: WSServerMessage) {
  const p = msg.payload as { id: string; name?: string | undefined };
  replyMeta(msg).setEnvRates({ contextMode: p.id });
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
    ...promptQueueHandlerMap,
    'mcp.server.disconnected': handleMcpServerDisconnected,
    'mcp.server.connected': handleMcpServerUp,
    'mcp.server.reconnected': handleMcpServerUp,
    'config.doctor.result': handleConfigDoctorResult,
    'browser.policy.result': handleBrowserPolicyResult,
    'session.start': (msg: WSServerMessage) => {
      handleSessionStart(msg);
      queryMailbox();
      requestPromptQueue(msg);
    },
    'specs.list': (msg: WSServerMessage) => {
      const p = msg.payload as { specs?: import('@/stores/specs-store').SpecListItem[] };
      useSpecsStore.getState().setSpecs(p.specs ?? []);
    },
    'specs.detail': (msg: WSServerMessage) => {
      const detail = msg.payload as unknown as import('@/stores/specs-store').SpecDetail;
      // Broadcast to every client: keep only the spec this view has expanded.
      if (detail?.specId !== useSpecsStore.getState().expandedSpecId) return;
      useSpecsStore.getState().setDetail(detail);
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
      // The list belongs to the run that recorded it. Gating on the foreground
      // threw away the reply a background tab had ASKED FOR, so opening that
      // tab showed an empty timeline for a run that had written files.
      const p = msg.payload as { sideEffects?: SideEffectEntry[] };
      useSideEffectStore
        .for(messageSessionId(msg))
        .getState()
        .setSideEffects(p.sideEffects ?? []);
    },
    'todos.updated': handleTodosUpdated,
    // The standalone server broadcasts `todos.cleared` on clear (the CLI server
    // sends `todos.updated` with an empty list); handle both so the worklist
    // empties in the UI regardless of which server is driving.
    'todos.cleared': (msg: WSServerMessage) => {
      // Same positive routing as `todos.updated`: land on the lane the frame
      // names and drop anything untagged — emptying the lane in front because
      // an untagged frame walked in is how one tab's clear wiped another's
      // board.
      const lane = sessionFor(msg);
      if (!lane) return;
      lane.setTodos([]);
    },
    'agent.timeline.message': (msg: WSServerMessage) => {
      // Stamped, not gated: the entry is filed under its own agent, and the
      // roster is session-filtered, so a background tab's worker keeps its
      // transcript instead of losing every line said while it was off screen.
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
        sessionId: messageSessionId(msg) ?? undefined,
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
        sessionId: messageSessionId(msg) ?? undefined,
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
      applyAtlasFrame(msg);
    },
    'tool.started': (msg: WSServerMessage) => {
      handleToolStarted(msg);
      applyAtlasFrame(msg);
    },
    'tool.executed': (msg: WSServerMessage) => {
      handleToolExecuted(msg);
      applyAtlasFrame(msg);
    },
    'codemap.tool_started': (msg: WSServerMessage) => {
      pipeViz(msg);
      applyAtlasFrame(msg);
    },
    'codemap.tool_executed': (msg: WSServerMessage) => {
      pipeViz(msg);
      applyAtlasFrame(msg);
    },
    'codemap.file_event': applyAtlasFrame,
    'codemap.index_updated': applyAtlasFrame,
    'file.saved': applyAtlasFrame,
    'memory.event': (msg: WSServerMessage) => {
      handleMemoryEvent(msg);
      const activities = extractActivitiesFromMessage(msg);
      if (activities.length > 0) {
        const store = useCodemapActivityStore.getState();
        for (const a of activities) store.recordActivity(a);
      }
    },
  };
