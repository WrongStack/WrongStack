import type { Context } from '@wrongstack/core/agent';
import type { EventName, Listener } from '@wrongstack/core/kernel';
import type { WebSocket } from 'ws';
import { extractCodeMapFileTargets } from './codemap-telemetry.js';
import type { SetupEventProjection } from './setup-event-projection.js';
import type { ConnectedClient, WSServerMessage } from './types.js';

export function registerSetupEventsSubagentHandlers(options: {
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
  projection?: SetupEventProjection | undefined;
  sessionPayload: <T extends Record<string, unknown>>(payload: T) => T;
}): void {
  const { on, broadcast, clients, context, projection, sessionPayload } = options;
  const scrub = <T>(value: T): T => (projection?.scrubObject?.(value) ?? value) as T;
  const projectRoot = context.projectRoot;

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
    // Deliver to the tab that OWNS the subagent. `payload.sessionId` is the
    // subagent's own session so the codemap can attribute the node, but no tab
    // subscribes to a subagent session — routing on it dropped every
    // subagent's codemap activity at the wire.
    broadcast(
      clients,
      {
        type: 'codemap.tool_started',
        payload: sessionPayload({
          sessionId: e.agentSessionId ?? e.sessionId ?? '',
          parentSessionId: e.sessionId,
          traceId: e.traceId,
          agentId: e.subagentId,
          agentName: e.agentName ?? e.subagentId,
          id: e.id,
          name: e.name,
          input: scrub(e.input),
          fileTargets: extractCodeMapFileTargets(projectRoot || '.', e.name, e.input),
        }),
      },
      e.sessionId,
    );
  });
  on('subagent.tool_executed', (e) => {
    broadcast(
      clients,
      {
        type: 'codemap.tool_executed',
        payload: sessionPayload({
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
        }),
      },
      e.sessionId,
    );
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

  on('tool.executed', (e) => {
    forwardSubagent('tool_executed', {
      sessionId: e.sessionId,
      subagentId: 'leader',
      toolName: e.name,
      durationMs: e.durationMs,
      ok: e.ok,
    });
  });

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

  on('iteration.completed', (e) => {
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
}
