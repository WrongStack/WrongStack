import { watch as fsWatch } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type {
  EventBus,
  EventName,
  Listener,
} from '@wrongstack/core/kernel';
import type { SessionEventBridge } from '@wrongstack/core/storage';
import type { WstackPaths } from '@wrongstack/core/utils';
import { recordTaskFileActivity } from '@wrongstack/kanban';
import { watchKanbanBoards } from './kanban-board-watcher.js';
import type { WebSocket } from 'ws';
import { extractCodeMapFileTargets, normalizeCodeMapFileTarget } from './codemap-telemetry.js';
import type { PendingConfirm } from './pending-confirms.js';
import type { SetupEventProjection } from './setup-event-projection.js';
import {
  type FileWatcherMetrics,
  shouldLogWatcherStats,
  statusProjectHashFromWatchFilename,
} from './setup-events-watcher.js';
import type { ConnectedClient, WSServerMessage } from './types.js';
export type { FileWatcherMetrics } from './setup-events-watcher.js';

export interface SetupEventsDeps {
  events: EventBus;
  broadcast: (clients: Map<WebSocket, ConnectedClient>, msg: WSServerMessage) => void;
  clients: Map<WebSocket, ConnectedClient>;
  config: { tools?: { maxIterations?: number | undefined } };
  context: Context;
  pendingConfirms: Map<string, PendingConfirm>;
  /** Optional global config dir (~/.wrongstack) — enables SessionRegistry poll for fleet view. */
  globalConfigPath?: string | undefined;
  /**
   * Audit-level-aware session log bridge. When provided, tool/error/provider
   * events are persisted to the session JSONL (same contract as the CLI) —
   * without it, standalone-WebUI sessions carry no audit events and resume
   * with no tool history.
   */
  sessionBridge?: SessionEventBridge | undefined;
  /** Optional wpaths for writing status.json file. */
  wpaths?: WstackPaths | undefined;
  /** Optional live file-watcher metrics sink. */
  watcherMetrics?: FileWatcherMetrics | undefined;
  /**
   * Receives the internal `broadcastSessions` fn so the HTTP layer can trigger
   * an immediate fleet re-broadcast on `POST /api/fleet/ping` (push-on-write
   * from a TUI/REPL), instead of waiting on the registry file-watch/poll.
   */
  onFleetBroadcaster?: ((fn: () => Promise<void>) => void) | undefined;
  /** Optional high-volume/sensitive event adapter used by embedded hosts. */
  projection?: SetupEventProjection | undefined;
}

export { statusProjectHashFromWatchFilename } from './setup-events-watcher.js';

/**
 * Wire kernel events to WS broadcasts and (when wpaths/globalConfigPath are
 * given) start the status-file watcher and session-poll interval.
 *
 * Returns a disposer that stops the watcher, clears the metrics/poll
 * intervals, and flushes pending debounce timers. Callers MUST invoke it on
 * shutdown — the watcher is `persistent: true` and the metrics interval is not
 * `unref`'d, so without disposal they keep the process alive and leak across
 * server restarts. (Previously this was hung off a non-existent
 * `process.on('cleanup')` event that never fired.)
 */
export function setupEvents(deps: SetupEventsDeps): () => void {
  const {
    events,
    broadcast,
    clients,
    config,
    context,
    pendingConfirms,
    globalConfigPath,
    sessionBridge,
    wpaths,
    watcherMetrics,
    onFleetBroadcaster,
    projection,
  } = deps;
  const scrub = <T>(value: T): T => (projection?.scrubObject?.(value) ?? value) as T;
  const disposers: Array<() => void> = [];
  let disposed = false;
  const on = <E extends EventName>(event: E, listener: Listener<E>): void => {
    disposers.push(events.on(event, listener));
  };
  // Partial standalone contexts may omit live todo state.
  const conversationState = (context as { state?: Context['state'] }).state;
  if (typeof conversationState?.onChange === 'function') {
    disposers.push(
      conversationState.onChange((change) => {
        if (change.kind !== 'todos_replaced') return;
        broadcast(clients, {
          type: 'todos.updated',
          payload: {
            sessionId: context.session?.id ?? '',
            todos: [...change.todos],
            revision: conversationState.revision,
          },
        });
      }),
    );
  }

  // ── Kanban board file watcher ────────────────────────────────────────────
  // When any board JSON changes on disk (external agent, another process),
  // push the updated board to every connected WebUI client so KanbanView
  // renders the live state without waiting for the next polling tick.
  // Extracted to kanban-board-watcher.ts so the CLI embedded server shares
  // the same liveness path (kanban events never reach the EventBus).
  const projectRoot = context.projectRoot;
  if (projectRoot) {
    disposers.push(watchKanbanBoards(projectRoot, (message) => broadcast(clients, message)));
  }
  const currentSessionId = (): string => context.session?.id ?? '';
  const sessionPayload = <T extends Record<string, unknown>>(
    payload: T,
  ): T & { sessionId: string } => {
    const provided = payload['sessionId'];
    const sessionId =
      typeof provided === 'string' && provided.length > 0 ? provided : currentSessionId();
    return { ...payload, sessionId };
  };
  const isCurrentSession = (sessionId?: string | undefined): boolean => {
    const current = currentSessionId();
    return !sessionId || !current || sessionId === current;
  };
  const appendForCurrentSession = (
    sessionId: string | undefined,
    event: Parameters<SessionEventBridge['append']>[0],
  ): void => {
    if (!isCurrentSession(sessionId)) return;
    sessionBridge?.append(event).catch(() => {
      /* best-effort */
    });
  };

  on('iteration.started', (e) => {
    // Read maxIterations from context.meta so the UI reflects the
    // webui setting, falling back to the startup config default.
    const maxIt =
      typeof context.meta['maxIterations'] === 'number'
        ? context.meta['maxIterations']
        : (config.tools?.maxIterations ?? 100);
    broadcast(clients, {
      type: 'iteration.started',
      payload: sessionPayload({ sessionId: e.sessionId, index: e.index, maxIterations: maxIt }),
    });
  });

  on('iteration.completed', (e) => {
    broadcast(clients, {
      type: 'iteration.completed',
      payload: sessionPayload({
        sessionId: e.sessionId,
        index: e.index,
        totalIterations: e.index + 1,
      }),
    });
  });

  on('iteration.limit_reached', (e) => {
    broadcast(clients, {
      type: 'iteration.limit_reached',
      payload: sessionPayload({
        sessionId: e.sessionId,
        currentIterations: e.currentIterations,
        currentLimit: e.currentLimit,
      }),
    });
  });

  on('provider.text_delta', (e) => {
    if (projection?.queueTextDelta) {
      projection.flushThinkingDelta?.();
      projection.queueTextDelta(e.text, e.sessionId);
      return;
    }
    broadcast(clients, {
      type: 'provider.text_delta',
      payload: sessionPayload({ sessionId: e.sessionId, text: e.text, messageId: 'current' }),
    });
  });

  on('provider.thinking_delta', (e) => {
    if (projection?.queueThinkingDelta) {
      projection.queueThinkingDelta(e.text, e.sessionId);
      return;
    }
    broadcast(clients, {
      type: 'provider.thinking_delta',
      payload: sessionPayload({ sessionId: e.sessionId, text: e.text }),
    });
  });

  on('provider.stream_error', (e) => {
    broadcast(clients, {
      type: 'provider.stream_error',
      payload: sessionPayload({ sessionId: e.sessionId, eventType: e.eventType, message: e.msg }),
    });
  });

  on('tool.started', (e) => {
    projection?.flushAllStreamBuffers?.();
    broadcast(clients, {
      type: 'tool.started',
      payload: sessionPayload({
        sessionId: e.sessionId,
        traceId: e.traceId,
        agentId: e.agentId,
        agentName: e.agentName,
        id: e.id,
        name: e.name,
        input: scrub(e.input),
        fileTargets: extractCodeMapFileTargets(projectRoot || '.', e.name, e.input),
        messageId: `tool_${e.id}`,
      }),
    });
    // Persist for audit + resume tool history (respects auditLevel).
    appendForCurrentSession(e.sessionId, {
      type: 'tool_call_start',
      ts: new Date().toISOString(),
      name: e.name,
      id: e.id,
      input: scrub(e.input),
    });
  });

  on('tool.progress', (e) => {
    const rawProgressPath =
      e.event.path ??
      (typeof e.event.data?.['path'] === 'string' ? e.event.data['path'] : undefined);
    const progressTarget = rawProgressPath
      ? normalizeCodeMapFileTarget(
          projectRoot || '.',
          rawProgressPath,
          e.event.operation ?? 'edit',
          e.event.line,
          e.event.endLine,
        )
      : undefined;
    const progressPayload = sessionPayload({
      sessionId: e.sessionId,
      traceId: e.traceId,
      agentId: e.agentId,
      agentName: e.agentName,
      id: e.id,
      name: e.name,
      event: {
        type: e.event.type,
        text: e.event.text,
        data: e.event.data,
        path: progressTarget?.filePath,
        operation: e.event.operation,
        line: progressTarget?.line,
        endLine: progressTarget?.endLine,
      },
    });
    if (projection?.queueToolProgress) {
      projection.queueToolProgress(progressPayload);
    } else
      broadcast(clients, {
        type: 'tool.progress',
        // Nested `event` shape — the client handler reads `payload.event?.text`
        // and early-returns on a falsy text, so a flat { eventType, text } payload
        // makes live tool progress (bash streaming, partial_output, warnings)
        // never render. Must match WSToolProgress and the CLI server.
        payload: progressPayload,
      });
    appendForCurrentSession(e.sessionId, {
      type: 'tool_progress',
      ts: new Date().toISOString(),
      name: e.name,
      id: e.id,
      event: {
        type: e.event.type,
        ...(e.event.text !== undefined ? { text: e.event.text } : {}),
        ...(e.event.data !== undefined ? { data: e.event.data } : {}),
      },
    });
  });

  on('tool.executed', (e) => {
    projection?.flushAllStreamBuffers?.();
    broadcast(clients, {
      type: 'tool.executed',
      payload: sessionPayload({
        sessionId: e.sessionId,
        traceId: e.traceId,
        agentId: e.agentId,
        agentName: e.agentName,
        id: e.id,
        name: e.name,
        durationMs: e.durationMs,
        ok: e.ok,
        input: scrub(e.input),
        fileTargets: extractCodeMapFileTargets(projectRoot || '.', e.name, e.input),
        output: scrub(e.output),
        outputBytes: e.outputBytes,
        outputTokens: e.outputTokens,
        outputLines: e.outputLines,
        metadata: e.metadata,
      }),
    });
    appendForCurrentSession(e.sessionId, {
      type: 'tool_call_end',
      ts: new Date().toISOString(),
      name: e.name,
      id: e.id ?? '',
      durationMs: e.durationMs,
      outputSize: e.outputBytes ?? 0,
      ok: e.ok,
      outputBytes: e.outputBytes,
      outputTokens: e.outputTokens,
      outputLines: e.outputLines,
    });
    broadcast(clients, {
      type: 'todos.updated',
      payload: sessionPayload({ sessionId: e.sessionId, todos: [...context.todos] }),
    });

    // P2 #5: push updated side effects after every tool execution so the
    // Audit tab refreshes automatically — no manual refresh needed.
    const sideEffects = context.sideEffects ?? [];
    if (sideEffects.length > 0) {
      broadcast(clients, {
        type: 'side_effects',
        payload: sessionPayload({
          sessionId: e.sessionId,
          sideEffects: sideEffects.slice(-50).map((se) => ({
            toolUseId: se.toolUseId,
            toolName: se.toolName,
            ts: se.ts,
            input: se.input,
            outcome: se.outcome,
            risk: se.risk,
          })),
        }),
      });
    }

    // Broadcast task/plan updates after task/plan/todo tool executions.
    if (e.name === 'task' || e.name === 'plan' || e.name === 'todo') {
      void (async () => {
        try {
          const taskPath = (context.meta as Record<string, unknown>)['task.path'];
          if (typeof taskPath === 'string' && taskPath) {
            const { loadTasks } = await import('@wrongstack/core/storage');
            const file = await loadTasks(taskPath);
            broadcast(clients, {
              type: 'tasks.updated',
              payload: sessionPayload({ sessionId: e.sessionId, tasks: file?.tasks ?? [] }),
            });
          }
        } catch {
          /* best-effort */
        }
        try {
          const planPath = (context.meta as Record<string, unknown>)['plan.path'];
          if (typeof planPath === 'string' && planPath) {
            const { loadPlan } = await import('@wrongstack/core/storage');
            const plan = await loadPlan(planPath);
            broadcast(clients, {
              type: 'plan.updated',
              payload: sessionPayload({
                sessionId: e.sessionId,
                plan: plan ?? {
                  version: 1,
                  sessionId: e.sessionId ?? context.session?.id ?? '',
                  updatedAt: new Date().toISOString(),
                  items: [],
                },
              }),
            });
          }
        } catch {
          /* best-effort */
        }
      })();
    }
  });

  on('file.activity', (e) => {
    broadcast(clients, { type: 'codemap.file_event', payload: e });
  });

  on('codemap.index_updated', (e) => {
    broadcast(clients, { type: 'codemap.index_updated', payload: e });
  });

  on('file.event', (e) => {
    if (e.scope !== 'task' || !e.boardId || !e.taskId || !projectRoot) return;
    void recordTaskFileActivity(projectRoot, e.boardId, e.taskId, e)
      .then((recorded) => {
        if (recorded) {
          broadcast(clients, {
            type: 'kanban.task.activity.changed',
            payload: { boardId: e.boardId, taskId: e.taskId },
          });
        }
      })
      .catch(() => {});
  });

  on('tool.loop_detected', (e) => {
    broadcast(clients, {
      type: 'tool.loop_detected',
      payload: sessionPayload({
        sessionId: e.sessionId,
        tools: e.tools,
        repeatCount: e.repeatCount,
        iteration: e.iteration,
        kind: e.kind,
        action: e.action,
        scope: e.scope,
      }),
    });
  });

  on('trust.persisted', (e) => {
    broadcast(clients, {
      type: 'trust.persisted',
      payload: sessionPayload({
        sessionId: e.sessionId,
        tool: e.tool,
        pattern: e.pattern,
        decision: e.decision,
      }),
    });
  });

  on('delegate.started', (e) => {
    broadcast(clients, {
      type: 'delegate.started',
      payload: sessionPayload({ sessionId: e.sessionId, target: e.target, task: e.task }),
    });
  });

  on('delegate.completed', (e) => {
    broadcast(clients, {
      type: 'delegate.completed',
      payload: sessionPayload({
        sessionId: e.sessionId,
        target: e.target,
        task: e.task,
        ok: e.ok,
        status: e.status,
        summary: e.summary,
        durationMs: e.durationMs,
        iterations: e.iterations,
        toolCalls: e.toolCalls,
        costUsd: e.costUsd,
        subagentId: e.subagentId,
      }),
    });
  });

  on('provider.response', (e) => {
    projection?.flushAllStreamBuffers?.();
    broadcast(clients, {
      type: 'provider.response',
      payload: sessionPayload({
        sessionId: e.sessionId,
        content: e.content,
        usage: e.usage,
        stopReason: e.stopReason,
        messageId: 'current',
      }),
    });
  });

  on('ctx.pct', (e) => {
    broadcast(clients, {
      type: 'ctx.pct',
      payload: sessionPayload({
        sessionId: e.sessionId,
        load: e.load,
        tokens: e.tokens,
        maxContext: e.maxContext,
      }),
    });
    broadcast(clients, {
      type: 'subagent.event',
      payload: sessionPayload({
        sessionId: e.sessionId,
        kind: 'ctx_pct',
        subagentId: 'leader',
        load: e.load,
        tokens: e.tokens,
        maxContext: e.maxContext,
      }),
    });
  });

  on('ctx.max_context', (e) => {
    broadcast(clients, {
      type: 'ctx.max_context',
      payload: sessionPayload({
        sessionId: e.sessionId,
        providerId: e.providerId,
        modelId: e.modelId,
        maxContext: e.maxContext,
      }),
    });
  });

  on('token.threshold', (e) => {
    broadcast(clients, {
      type: 'token.threshold',
      payload: sessionPayload({ sessionId: e.sessionId, used: e.used, limit: e.limit }),
    });
  });

  on('token.cost_estimate_unavailable', (e) => {
    broadcast(clients, {
      type: 'token.cost_estimate_unavailable',
      payload: sessionPayload({ sessionId: e.sessionId, model: e.model }),
    });
  });

  on('context.repaired', (e) => {
    broadcast(clients, {
      type: 'context.repaired',
      payload: sessionPayload({
        sessionId: e.sessionId,
        removedToolUses: e.removedToolUses,
        removedToolResults: e.removedToolResults,
        removedMessages: e.removedMessages,
      }),
    });
  });

  on('tool.confirm_needed', (e) => {
    const id = e.toolUseId ?? `confirm_${Date.now()}`;
    const payload = sessionPayload({
      sessionId: e.sessionId,
      id,
      toolName: e.tool?.name ?? 'unknown',
      input: scrub(e.input),
      suggestedPattern: e.suggestedPattern,
      decisionSource: e.decisionSource,
      riskTier: e.riskTier,
      boundaryReason: e.boundaryReason,
    });
    pendingConfirms.set(id, {
      resolve: e.resolve,
      decisionSource: e.decisionSource,
      riskTier: e.riskTier,
      boundaryReason: e.boundaryReason,
      payload,
    });
    broadcast(clients, { type: 'tool.confirm_needed', payload });
  });

  on('error', (e) => {
    broadcast(clients, {
      type: 'error',
      payload: sessionPayload({
        sessionId: e.sessionId,
        phase: e.phase,
        message: e.err instanceof Error ? e.err.message : String(e.err),
      }),
    });
    appendForCurrentSession(e.sessionId, {
      type: 'error',
      ts: new Date().toISOString(),
      message: e.err instanceof Error ? e.err.message : String(e.err),
      phase: e.phase,
    });
  });

  on('session.damaged', (e) => {
    broadcast(clients, {
      type: 'session.damaged',
      payload: { sessionId: e.sessionId, detail: e.detail },
    });
  });

  on('session.rewound', (e) => {
    broadcast(clients, {
      type: 'session.rewound',
      payload: sessionPayload({
        sessionId: e.sessionId,
        toPromptIndex: e.toPromptIndex,
        revertedFiles: e.revertedFiles,
        removedEvents: e.removedEvents,
      }),
    });
  });

  on('checkpoint.written', (e) => {
    broadcast(clients, {
      type: 'checkpoint.written',
      payload: sessionPayload({
        sessionId: e.sessionId,
        promptIndex: e.promptIndex,
        promptPreview: e.promptPreview,
        ts: e.ts,
        fileCount: e.fileCount,
      }),
    });
  });

  on('in_flight.started', (e) => {
    broadcast(clients, {
      type: 'in_flight.started',
      payload: sessionPayload({ sessionId: e.sessionId, context: e.context, ts: e.ts }),
    });
  });

  on('in_flight.ended', (e) => {
    broadcast(clients, {
      type: 'in_flight.ended',
      payload: sessionPayload({ sessionId: e.sessionId, reason: e.reason, ts: e.ts }),
    });
  });

  // Provider visibility — retry storms and provider failures in the JSONL
  // for forensics, mirroring the CLI's bridge wiring.
  on('provider.retry', (e) => {
    broadcast(clients, {
      type: 'provider.retry',
      payload: sessionPayload({
        sessionId: e.sessionId,
        providerId: e.providerId,
        attempt: e.attempt,
        delayMs: e.delayMs,
        status: e.status,
        description: e.description,
      }),
    });
    appendForCurrentSession(e.sessionId, {
      type: 'provider_retry',
      ts: new Date().toISOString(),
      providerId: e.providerId,
      attempt: e.attempt,
      delayMs: e.delayMs,
      status: e.status,
      description: e.description,
    });
  });

  on('provider.status_changed', (e) => {
    broadcast(clients, {
      type: 'provider.status_changed',
      payload: sessionPayload({
        providerId: e.providerId,
        model: e.model,
        oldState: e.oldState,
        newState: e.newState,
        reason: e.reason,
        timestamp: e.timestamp,
        stateExpiresAt: e.stateExpiresAt,
      }),
    });
  });

  on('provider.active_blocked', (e) => {
    broadcast(clients, {
      type: 'provider.active_blocked',
      payload: sessionPayload({
        sessionId: e.sessionId,
        providerId: e.providerId,
        model: e.model,
        state: e.state,
        fallbackProviderId: e.fallbackProviderId,
        fallbackModel: e.fallbackModel,
        lastError: e.lastError,
        timestamp: e.timestamp,
      }),
    });
  });

  on('provider.error', (e) => {
    broadcast(clients, {
      type: 'provider.error',
      payload: sessionPayload({
        sessionId: e.sessionId,
        providerId: e.providerId,
        status: e.status,
        description: e.description,
        retryable: e.retryable,
      }),
    });
    appendForCurrentSession(e.sessionId, {
      type: 'provider_error',
      ts: new Date().toISOString(),
      providerId: e.providerId,
      status: e.status,
      description: e.description,
      retryable: e.retryable,
    });
  });

  on('provider.fallback', (e) => {
    broadcast(clients, {
      type: 'provider.fallback',
      payload: sessionPayload({
        sessionId: e.sessionId,
        from: e.from,
        to: e.to,
        status: e.status,
        providerSwitched: e.providerSwitched,
      }),
    });
  });

  on('compaction.fired', (e) => {
    broadcast(clients, {
      type: 'context.compacted',
      payload: sessionPayload({
        sessionId: e.sessionId,
        before: e.report.before,
        after: e.report.after,
        saved: Math.max(0, e.report.before - e.report.after),
        reductions: e.report.reductions,
      }),
    });
  });

  on('compaction.failed', (e) => {
    broadcast(clients, {
      type: 'compaction.failed',
      payload: sessionPayload({
        sessionId: e.sessionId,
        message: e.err.message,
        aggressive: e.aggressive,
        level: e.level,
        tokens: e.tokens,
        maxContext: e.maxContext,
        load: e.load,
        fatal: e.fatal,
      }),
    });
  });

  on('mcp.server.connected', (e) => {
    broadcast(clients, {
      type: 'mcp.server.connected',
      payload: { name: e.name, toolCount: e.toolCount },
    });
  });

  on('mcp.server.reconnected', (e) => {
    broadcast(clients, {
      type: 'mcp.server.reconnected',
      payload: { name: e.name, toolCount: e.toolCount },
    });
  });

  on('mcp.server.disconnected', (e) => {
    broadcast(clients, {
      type: 'mcp.server.disconnected',
      payload: { name: e.name, reason: e.reason },
    });
  });

  on('coordinator.stats', (e) => {
    broadcast(clients, {
      type: 'coordinator.stats',
      payload: sessionPayload({
        sessionId: e.sessionId,
        total: e.total,
        running: e.running,
        idle: e.idle,
        stopped: e.stopped,
        inFlight: e.inFlight,
        pending: e.pending,
        completed: e.completed,
        subagentStatuses: e.subagentStatuses.map((s) => ({
          id: s.subagentId,
          name: s.subagentId,
          status: s.status,
          currentTask: s.taskId,
        })),
      }),
    });
  });

  // ── Inter-agent mailbox visibility ───────────────────────────────────
  // Forward cross-session mailbox activity (messages received by this
  // process's agents, new agent registrations on the project) to the
  // browser so the user sees multi-terminal/multi-surface chatter live.
  // These events are emitted via emit() with untyped names (GlobalMailbox
  // + mailbox-loop), so subscribe by pattern like the TUI does.
  disposers.push(
    events.onPattern('mailbox.received', (_e, payload) => {
      broadcast(clients, { type: 'mailbox.received', payload } as never as WSServerMessage);
    }),
    events.onPattern('mailbox.agent_registered', (_e, payload) => {
      broadcast(clients, {
        type: 'mailbox.agent_registered',
        payload,
      } as never as WSServerMessage);
    }),
  );

  // Subagent fleet lifecycle
  const forwardSubagent = (kind: string, payload: Record<string, unknown>) =>
    broadcast(clients, { type: 'subagent.event', payload: sessionPayload({ kind, ...payload }) });

  on('subagent.spawned', (e) =>
    forwardSubagent('spawned', {
      sessionId: e.sessionId,
      subagentId: e.subagentId,
      taskId: e.taskId,
      name: e.name,
      provider: e.provider,
      model: e.model,
      description: e.description,
    }),
  );
  on('subagent.task_started', (e) =>
    forwardSubagent('task_started', {
      sessionId: e.sessionId,
      subagentId: e.subagentId,
      taskId: e.taskId,
      description: e.description,
    }),
  );
  on('subagent.tool_started', (e) => {
    broadcast(clients, {
      type: 'codemap.tool_started',
      payload: {
        sessionId: e.agentSessionId ?? e.sessionId ?? '',
        parentSessionId: e.sessionId,
        traceId: e.traceId,
        agentId: e.subagentId,
        agentName: e.agentName ?? e.subagentId,
        id: e.id,
        name: e.name,
        input: scrub(e.input),
        fileTargets: extractCodeMapFileTargets(projectRoot || '.', e.name, e.input),
      },
    });
  });
  on('subagent.tool_executed', (e) => {
    broadcast(clients, {
      type: 'codemap.tool_executed',
      payload: {
        sessionId: e.agentSessionId ?? e.sessionId ?? '',
        parentSessionId: e.sessionId,
        traceId: e.traceId,
        agentId: e.subagentId,
        agentName: e.agentName ?? e.subagentId,
        id: e.id,
        name: e.name,
        durationMs: e.durationMs,
        ok: e.ok,
        input: scrub(e.input),
        fileTargets: extractCodeMapFileTargets(projectRoot || '.', e.name, e.input),
        output: scrub(e.output),
        outputBytes: e.outputBytes,
        outputTokens: e.outputTokens,
        outputLines: e.outputLines,
      },
    });
    forwardSubagent('tool_executed', {
      sessionId: e.sessionId,
      subagentId: e.subagentId,
      toolName: e.name,
      durationMs: e.durationMs,
      ok: e.ok,
    });
  });
  on('subagent.iteration_summary', (e) =>
    forwardSubagent('iteration_summary', {
      sessionId: e.sessionId,
      subagentId: e.subagentId,
      iteration: e.iteration,
      toolCalls: e.toolCalls,
      costUsd: e.costUsd,
      currentTool: e.currentTool,
      partialText: e.partialText,
    }),
  );
  on('subagent.budget_warning', (e) =>
    forwardSubagent('budget_warning', {
      sessionId: e.sessionId,
      subagentId: e.subagentId,
      budgetKind: e.kind,
      used: e.used,
      limit: e.limit,
    }),
  );
  on('subagent.budget_extended', (e) =>
    forwardSubagent('budget_extended', {
      sessionId: e.sessionId,
      subagentId: e.subagentId,
      budgetKind: e.kind,
      newLimit: e.newLimit,
      totalExtensions: e.totalExtensions,
    }),
  );
  on('subagent.ctx_pct', (e) =>
    forwardSubagent('ctx_pct', {
      sessionId: e.sessionId,
      subagentId: e.subagentId,
      load: e.load,
      tokens: e.tokens,
      maxContext: e.maxContext,
    }),
  );
  on('subagent.task_completed', (e) =>
    forwardSubagent('task_completed', {
      sessionId: e.sessionId,
      subagentId: e.subagentId,
      status: e.status,
      iterations: e.iterations,
      toolCalls: e.toolCalls,
      finalText: (e as Record<string, unknown>).finalText as string | undefined,
      failureReason: e.error?.kind,
      error: e.error ? { kind: e.error.kind, message: e.error.message } : undefined,
    }),
  );
  on('subagent.removed', (e) =>
    forwardSubagent('removed', {
      sessionId: e.sessionId,
      subagentId: e.subagentId,
      reason: e.reason,
    }),
  );

  on('agent.timeline.message', (e) => {
    const timeline = e as typeof e & { toolOk?: boolean };
    broadcast(clients, {
      type: 'agent.timeline.message',
      payload: sessionPayload({
        sessionId: e.sessionId,
        subagentId: e.subagentId,
        agentName: e.agentName,
        content: e.content,
        kind: e.kind,
        iteration: e.iteration,
        ts: e.ts,
        toolName: e.toolName,
        ...(typeof timeline.toolOk === 'boolean' ? { toolOk: timeline.toolOk } : {}),
        costUsd: e.costUsd,
      }),
    });
  });
  on('agent.status_changed', (e) => {
    broadcast(clients, {
      type: 'agent.status_changed',
      payload: sessionPayload({
        sessionId: e.sessionId,
        subagentId: e.subagentId,
        agentName: e.agentName,
        status: e.status,
        ts: e.ts,
        summary: e.summary,
        task: e.task,
      }),
    });
  });

  // ── Leader (main session) events — forwarded as subagent.event with subagentId 'leader' ──
  // These give the AgentsPage a live leader row with real-time tool tracking,
  // context pressure — matching the TUI's leader entry.
  // Iteration counts, cost, and overall status come from the sessionStore on the frontend.

  // Leader spawned: sent on first iteration so the frontend creates the leader row.
  let leaderSpawned = false;
  on('iteration.started', (e) => {
    if (!leaderSpawned) {
      leaderSpawned = true;
      const provider = (context.provider as { id?: string } | undefined)?.id ?? 'unknown';
      forwardSubagent('spawned', {
        sessionId: e.sessionId,
        subagentId: 'leader',
        name: 'LEADER',
        provider,
        model: context.model,
        description: `Main agent session (${context.session.id})`,
      });
    }
  });

  // Leader tool execution: emitted on every tool.executed in the main session.
  on('tool.executed', (e) => {
    forwardSubagent('tool_executed', {
      sessionId: e.sessionId,
      subagentId: 'leader',
      toolName: e.name,
      durationMs: e.durationMs,
      ok: e.ok,
    });
  });

  // Leader context pressure + cost: emitted on every provider response.
  on('provider.response', (e) => {
    if (e.usage?.input != null) {
      const maxCtx = context.provider.capabilities.maxContext;
      const rawLoad = maxCtx > 0 ? e.usage.input / maxCtx : 0;
      const load = Math.max(0, Math.min(1, rawLoad));
      const costUsd = context.tokenCounter.estimateCost().total;
      forwardSubagent('ctx_pct', {
        sessionId: e.sessionId,
        subagentId: 'leader',
        load,
        rawLoad,
        tokens: e.usage.input,
        maxContext: maxCtx,
        costUsd,
      });
    }
  });

  // Leader iteration updates: we already track iteration started above.
  // The frontend uses sessionStore for accurate cost/iteration counts.
  // When the run completes, the frontend's run.result handler resets isLoading,
  // making the leader go idle. We reset leader state on iteration.started.
  on('iteration.completed', (e) => {
    // Respawn leader if it was cleared (e.g., on session resume).
    if (!leaderSpawned) {
      leaderSpawned = true;
      const provider = (context.provider as { id?: string } | undefined)?.id ?? 'unknown';
      forwardSubagent('spawned', {
        sessionId: e.sessionId,
        subagentId: 'leader',
        name: 'LEADER',
        provider,
        model: context.model,
        description: `Main agent session (${context.session.id})`,
      });
    }
  });

  // ── Mailbox events — broadcast to WebUI for real-time per-project visibility ──
  disposers.push(
    events.onPattern('mailbox.*', (eventName, payload) => {
      broadcast(clients, {
        type: 'mailbox.event',
        payload: sessionPayload({ event: eventName, ...(payload as Record<string, unknown>) }),
      });
    }),

    // ── Brain events — decisions + proactive interventions, live in the browser ──
    events.onPattern('brain.*', (eventName, payload) => {
      broadcast(clients, {
        type: 'brain.event',
        payload: sessionPayload({ event: eventName, ...(payload as Record<string, unknown>) }),
      } as never as WSServerMessage);
    }),

    // ── SAGE events — retrieval, verification and hygiene observability ──
    events.onPattern('memory.*', (eventName, payload) => {
      broadcast(clients, {
        type: 'memory.event',
        payload: sessionPayload({ event: eventName, ...(payload as Record<string, unknown>) }),
      });
    }),

    // ── Cron plugin events — broadcast state snapshots so WebUI tracks active jobs ──
    events.onPattern('cron:state_snapshot', (_eventName, payload) => {
      broadcast(clients, {
        type: 'cron.snapshot',
        payload,
      } as never as WSServerMessage);
    }),
    events.onPattern('cron:job_fired', (_eventName, payload) => {
      broadcast(clients, {
        type: 'cron.job_fired',
        payload,
      } as never as WSServerMessage);
    }),
  );

  // ── Client status events — immediate broadcast to WebUI + write to status.json ──
  // Emitted by TUI/CLI/WebUI when significant status changes occur (tool calls, tokens, etc.)
  on('client.status', async (e) => {
    // Immediately broadcast to all connected WebUI clients
    broadcast(clients, { type: 'client.status_update', payload: e });

    // Write to status.json file for external watchers (e.g., other tools monitoring this project)
    if (wpaths?.projectStatus) {
      try {
        const statusFile = wpaths.projectStatus(e.projectHash);
        const dir = path.dirname(statusFile);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(statusFile, JSON.stringify(e, null, 2), 'utf-8');
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'setup_events.status_write_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  });

  // ── File watcher for external status.json changes ──
  // Watches ~/.wrongstack/projects/<hash>/status.json files for external tool changes.
  // Uses project hash filtering and debouncing to handle rapid writes efficiently.
  if (wpaths?.projectStatus && wpaths.globalRoot) {
    // projectsDir = ~/.wrongstack/projects/
    const projectsDir = path.join(wpaths.globalRoot, 'projects');

    // Track known project hashes (populated from incoming client.status events)
    const knownProjectHashes = new Set<string>();

    // Debounce state: map of projectHash -> timer
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const DEBOUNCE_MS = 150; // Wait 150ms after last write before broadcasting

    // Track pending status updates for debouncing (with write timestamps for delay calculation)
    const pendingStatuses = new Map<string, { data: unknown; firstWriteAt: number }>();

    // Initialize the external watcher metrics object if provided
    if (watcherMetrics) {
      watcherMetrics.fileChangesDetected = 0;
      watcherMetrics.filesProcessed = 0;
      watcherMetrics.broadcastsSent = 0;
      watcherMetrics.debounceResets = 0;
      watcherMetrics.totalDebounceDelayMs = 0;
      watcherMetrics.activeProjects = 0;
      watcherMetrics.averageDebounceDelayMs = 0;
      watcherMetrics.watcherActive = true;
    }

    const getAverageDebounceDelay = (): number => {
      if (!watcherMetrics || watcherMetrics.broadcastsSent === 0) return 0;
      return watcherMetrics.totalDebounceDelayMs / watcherMetrics.broadcastsSent;
    };

    const logWatcherMetricsEnabled = shouldLogWatcherStats();
    const logWatcherMetrics = () => {
      if (!watcherMetrics || !logWatcherMetricsEnabled) return;
      // Update computed field
      watcherMetrics.averageDebounceDelayMs = getAverageDebounceDelay();
      console.log(
        `[setup-events] File watcher stats: ` +
          `${watcherMetrics.broadcastsSent} broadcasts, ` +
          `${watcherMetrics.fileChangesDetected} file changes, ` +
          `${watcherMetrics.debounceResets} debounce resets, ` +
          `avg delay: ${watcherMetrics.averageDebounceDelayMs.toFixed(1)}ms, ` +
          `${watcherMetrics.activeProjects} active projects`,
      );
    };

    // Log metrics only when explicitly requested. The watcher observes the
    // whole projects directory recursively, so periodic stats are noisy in the
    // desktop app when several runtimes are active.
    const metricsInterval = logWatcherMetricsEnabled
      ? setInterval(logWatcherMetrics, 60_000)
      : undefined;

    const broadcastStatus = (_projectHash: string, statusData: unknown, actualDelayMs: number) => {
      broadcast(clients, { type: 'client.status_update', payload: statusData });
      if (watcherMetrics) {
        watcherMetrics.broadcastsSent++;
        watcherMetrics.totalDebounceDelayMs += actualDelayMs;
        watcherMetrics.averageDebounceDelayMs = getAverageDebounceDelay();
      }
    };

    const scheduleBroadcast = (projectHash: string, statusData: unknown) => {
      const now = Date.now();
      const existing = pendingStatuses.get(projectHash);

      // Track if this is a debounce reset (rapid successive write)
      if (existing && watcherMetrics) {
        watcherMetrics.debounceResets++;
      }

      // Store latest status data with first write timestamp
      pendingStatuses.set(projectHash, {
        data: statusData,
        firstWriteAt: existing ? existing.firstWriteAt : now,
      });

      // Clear existing timer for this project
      const existingTimer = debounceTimers.get(projectHash);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Set new debounce timer
      const timer = setTimeout(() => {
        debounceTimers.delete(projectHash);
        const pending = pendingStatuses.get(projectHash);
        if (pending) {
          const actualDelay = Date.now() - pending.firstWriteAt;
          broadcastStatus(projectHash, pending.data, actualDelay);
          pendingStatuses.delete(projectHash);
        }
      }, DEBOUNCE_MS);

      debounceTimers.set(projectHash, timer);
    };

    let watcher: import('fs').FSWatcher | undefined;

    const startWatcher = async () => {
      try {
        // Ensure directory exists before watching. Teardown may happen while
        // mkdir is pending, so do not create a persistent watcher afterwards.
        await fs.mkdir(projectsDir, { recursive: true });
        if (disposed) return;

        // Use fs.watch for efficient file change detection
        // Watch the projects directory for changes to status.json files
        // recursive:true so nested `<hash>/status.json` writes are delivered —
        // a non-recursive watch on the parent dir does not reliably fire for
        // changes inside subdirectories. filename can be null on some platforms.
        watcher = fsWatch(
          projectsDir,
          { persistent: true, recursive: true },
          async (eventType, filename) => {
            if (eventType !== 'change' && eventType !== 'rename') return;
            if (filename == null) return;
            const projectHash = statusProjectHashFromWatchFilename(projectsDir, filename);
            if (!projectHash) return;

            if (watcherMetrics) watcherMetrics.fileChangesDetected++;

            // Only process project hashes this WebUI runtime already knows about
            // from client.status. This avoids every desktop runtime reacting to
            // unrelated ~/.wrongstack project churn.
            if (!knownProjectHashes.has(projectHash)) return;

            if (watcherMetrics) watcherMetrics.filesProcessed++;

            try {
              const targetFile = path.join(projectsDir, projectHash, 'status.json');
              const content = await fs.readFile(targetFile, 'utf-8');
              const statusData = JSON.parse(content);

              // Debounce the broadcast
              scheduleBroadcast(projectHash, statusData);
            } catch {
              // File may not exist, be readable yet, or invalid JSON
            }
          },
        );

        if (logWatcherMetricsEnabled) {
          console.log(
            `[setup-events] Watching ${projectsDir} for status.json changes (hash-filtered, debounced)`,
          );
        }
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'setup_events.status_watcher_start_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    };

    // Register incoming client.status events to build known project hashes
    // This ensures we only watch directories that have emitted status before
    on('client.status', (e) => {
      if (e.projectHash) {
        const hash = String(e.projectHash);
        if (!knownProjectHashes.has(hash)) {
          knownProjectHashes.add(hash);
          if (watcherMetrics) watcherMetrics.activeProjects = knownProjectHashes.size;
        }
      }
    });

    // Start watcher asynchronously without blocking setup
    startWatcher();

    // Clean up watcher and timers on shutdown. Registered as a disposer so it
    // actually runs (the previous `process.on('cleanup')` event never fires).
    disposers.push(() => {
      if (metricsInterval) clearInterval(metricsInterval);
      logWatcherMetrics(); // Final metrics log on shutdown

      // Mark watcher as inactive
      if (watcherMetrics) watcherMetrics.watcherActive = false;

      // Flush any pending broadcasts before cleanup
      for (const [projectHash, pending] of pendingStatuses) {
        const timer = debounceTimers.get(projectHash);
        if (timer) {
          clearTimeout(timer);
          // Broadcast pending status immediately on shutdown
          broadcastStatus(projectHash, pending.data, 0);
        }
      }

      // Clear all debounce timers
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      pendingStatuses.clear();

      if (watcher) {
        watcher.close();
        if (logWatcherMetricsEnabled) console.log('[setup-events] Closed status file watcher');
      }
    });
  }

  // ── Cross-process session / fleet status ──
  // Read the SessionRegistry and broadcast live session+agent status to all
  // connected clients. Three triggers, from fastest to slowest: a push-on-write
  // `POST /api/fleet/ping` (via onFleetBroadcaster, ~ms), an `fs.watch` on the
  // registry file (~150ms), and a 5s fallback poll that also prunes stale
  // entries via `list()`.
  const globalRoot = globalConfigPath ? path.dirname(globalConfigPath) : undefined;
  if (globalRoot) {
    const broadcastSessions = async () => {
      try {
        const { SessionRegistry } = await import('@wrongstack/core/storage');
        const registry = new SessionRegistry(globalRoot);
        const sessions = await registry.list();
        // Scope Fleet HQ to the *same project* as this server. The registry lists
        // every project's sessions, so derive our current project from our own
        // entry (matched by pid — survives in-place project switches, unlike the
        // launch-time `wpaths.projectSlug`). Fall back to all sessions if our
        // entry isn't found yet (first tick before registration settles), use
        // the server's canonical project slug/root — never leak other projects
        // into this Office during that startup window.
        const ownEntry = sessions.find((s) => s.pid === process.pid);
        const mySlug = ownEntry?.projectSlug ?? wpaths?.projectSlug;
        const myRoot = path.resolve(context.projectRoot);
        const live = sessions
          // Only surface sessions with fresh heartbeats. 'stale' = process
          // dead, 'lost' = heartbeat timed out, 'closing' = process shut down.
          // Showing anything other than 'active'/'idle' means the HQ map
          // accumulates dead client entries that never go away until the 5 min
          // LOST_GRACE_MS or CLOSING_GRACE_MS expires.
          .filter((s) => s.status === 'active' || s.status === 'idle')
          .filter((s) =>
            mySlug ? s.projectSlug === mySlug : path.resolve(s.projectRoot) === myRoot,
          )
          .map((s) => ({
            sessionId: s.sessionId,
            projectName: s.projectName,
            projectSlug: s.projectSlug,
            projectRoot: s.projectRoot,
            workingDir: s.workingDir,
            gitBranch: s.gitBranch,
            // Surface (tui/webui/cli) so Fleet HQ can label each live client node.
            clientType: s.clientType,
            status: s.status,
            pid: s.pid,
            startedAt: s.startedAt,
            lastHeartbeatAt: s.lastHeartbeatAt,
            agentCount: s.agentCount,
            agents: (s.agents ?? []).map((a) => ({
              id: a.id,
              name: a.name,
              status: a.status,
              currentTool: a.currentTool,
              currentTask: a.currentTask,
              taskId: a.taskId,
              iterations: a.iterations,
              toolCalls: a.toolCalls,
              costUsd: a.costUsd,
              tokensIn: a.tokensIn,
              tokensOut: a.tokensOut,
              ctxPct: a.ctxPct,
              model: a.model,
              partialText: a.partialText,
              recentTools: a.recentTools,
              recentMail: a.recentMail,
              todos: a.todos,
              latestPrompt: a.latestPrompt,
              latestPromptAt: a.latestPromptAt,
              activity: a.activity,
              lastActivityAt: a.lastActivityAt,
            })),
          }));
        broadcast(clients, { type: 'sessions.status_update', payload: { sessions: live } });
      } catch {
        // Best-effort — never crash for status broadcasting errors
      }
    };

    // Hand the broadcaster to the HTTP layer for push-on-write (/api/fleet/ping).
    onFleetBroadcaster?.(broadcastSessions);

    // Fallback poll (also prunes stale entries on read). While the registry
    // watcher below is live, changes arrive in ~150ms and the poll only has
    // to reap stale entries — relax it. Without a watcher (unsupported
    // platform, or the watcher errored) fall back to the 5s cadence.
    let regWatchLive = false;
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleStatusPoll = (): void => {
      if (disposed) return;
      statusTimer = setTimeout(
        () => {
          void broadcastSessions();
          scheduleStatusPoll();
        },
        regWatchLive ? 30_000 : 5_000,
      );
      if (statusTimer.unref) statusTimer.unref();
    };
    disposers.push(() => {
      if (statusTimer) clearTimeout(statusTimer);
    });

    // Event-driven: watch the registry file so a TUI/REPL agent's write reaches
    // the map in ~150ms. Atomic writes go via `<file>.<uuid>.tmp` → rename, so
    // watch the dir and match any `session-registry.json*` change (ignore .lock).
    let regDebounce: ReturnType<typeof setTimeout> | undefined;
    try {
      const regWatcher = fsWatch(globalRoot, { persistent: false }, (_event, filename) => {
        const name = filename ? String(filename) : '';
        if (!name.startsWith('session-registry.json') || name.endsWith('.lock')) return;
        if (regDebounce) clearTimeout(regDebounce);
        regDebounce = setTimeout(() => void broadcastSessions(), 150);
      });
      // Without a listener an FSWatcher 'error' event is an uncaught
      // exception. Windows surfaces transient EPERMs here; degrade to the
      // fast poll instead of crashing the server.
      regWatcher.on('error', () => {
        regWatchLive = false;
        try {
          regWatcher.close();
        } catch {
          /* already closed */
        }
      });
      regWatchLive = true;
      disposers.push(() => {
        if (regDebounce) clearTimeout(regDebounce);
        regWatcher.close();
      });
    } catch {
      // Watch unsupported on this platform — the 5s poll still covers it.
    }
    scheduleStatusPoll();

    // Push an immediate snapshot so a freshly-connected client doesn't wait.
    void broadcastSessions();
  }

  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* best-effort teardown */
      }
    }
  };
}
