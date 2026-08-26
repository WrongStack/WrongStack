import type { Context } from '@wrongstack/core/agent';
import type { EventName, Listener } from '@wrongstack/core/kernel';
import type { SessionEventBridge } from '@wrongstack/core/storage';
import { recordTaskFileActivity } from '@wrongstack/kanban';
import type { WebSocket } from 'ws';
import { extractCodeMapFileTargets, normalizeCodeMapFileTarget } from './codemap-telemetry.js';
import type { PendingConfirm } from './pending-confirms.js';
import type { SetupEventProjection } from './setup-event-projection.js';
import type { ConnectedClient, WSServerMessage } from './types.js';

export function registerSetupEventsToolHandlers(options: {
  on: <E extends EventName>(event: E, listener: Listener<E>) => void;
  broadcast: (
    clients: Map<WebSocket, ConnectedClient>,
    msg: WSServerMessage,
    /** Deliver to the tab that owns this session, overriding the id on the
     *  payload. Needed when the payload names a SUBAGENT's session, which no
     *  tab subscribes to. */
    targetSessionId?: string,
  ) => void;
  clients: Map<WebSocket, ConnectedClient>;
  context: Context;
  pendingConfirms: Map<string, PendingConfirm>;
  projection?: SetupEventProjection | undefined;
  sessionPayload: <T extends Record<string, unknown>>(payload: T) => T;
  appendForCurrentSession: (
    sessionId: string | undefined,
    event: Parameters<SessionEventBridge['append']>[0],
  ) => void;
}): void {
  const {
    on,
    broadcast,
    clients,
    context,
    pendingConfirms,
    projection,
    sessionPayload,
    appendForCurrentSession,
  } = options;
  const scrub = <T>(value: T): T => (projection?.scrubObject?.(value) ?? value) as T;
  const projectRoot = context.projectRoot;

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
    } else {
      broadcast(clients, {
        type: 'tool.progress',
        payload: progressPayload,
      });
    }
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
        ...(e.sage && e.sage.length > 0 ? { sage: e.sage.map((line) => scrub(line)) } : {}),
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
    broadcast(clients, {
      type: 'codemap.file_event',
      payload: sessionPayload(e as unknown as Record<string, unknown>),
    });
  });

  on('codemap.index_updated', (e) => {
    broadcast(clients, {
      type: 'codemap.index_updated',
      payload: sessionPayload(e as unknown as Record<string, unknown>),
    });
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
      sessionId: e.sessionId,
      decisionSource: e.decisionSource,
      riskTier: e.riskTier,
      boundaryReason: e.boundaryReason,
      payload,
    });
    broadcast(clients, { type: 'tool.confirm_needed', payload });
  });
}
