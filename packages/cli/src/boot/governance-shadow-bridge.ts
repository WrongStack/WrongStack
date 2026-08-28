import type { EventBus, EventMap, EventName } from '@wrongstack/core/kernel';
import type {
  GovernanceRuntimeObservationInput,
  GovernanceRuntimeObservationResult,
} from '@wrongstack/runtime/governance-bootstrap';
import { createGovernanceEvidenceCandidate } from './governance-evidence-candidate.js';
import type { GovernanceTraceContext } from './governance-trace-context.js';

const SHADOW_SOURCE = 'wrongstack.cli.shadow.v1';

interface GovernanceObservationSink {
  observe(input: GovernanceRuntimeObservationInput): Promise<GovernanceRuntimeObservationResult>;
}

interface GovernanceShadowLogger {
  warn(message: string, context?: unknown): void;
}

interface GovernanceShadowBridge {
  close(): void;
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

export function createGovernanceShadowBridge(input: {
  readonly events: EventBus;
  readonly sink: GovernanceObservationSink;
  readonly logger: GovernanceShadowLogger;
  readonly trace: GovernanceTraceContext;
}): GovernanceShadowBridge {
  const disposers: Array<() => void> = [];
  let closed = false;
  let warned = false;

  const warnOnce = (message: string, context?: unknown): void => {
    if (warned || closed) return;
    warned = true;
    input.logger.warn(message, context);
  };

  const observe = (observation: GovernanceRuntimeObservationInput): void => {
    if (closed) return;
    try {
      void input.sink.observe(observation).then(
        (result) => {
          if (!result.recorded) {
            warnOnce('governance: shadow observation was not recorded', {
              code: result.code,
              message: result.message,
            });
          }
        },
        (error) => {
          warnOnce('governance: shadow observation failed open', {
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
    } catch (error) {
      warnOnce('governance: shadow observation failed open', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const on = <E extends EventName>(
    event: E,
    map: (payload: EventMap[E]) => GovernanceRuntimeObservationInput,
  ): void => {
    disposers.push(input.events.on(event, (payload) => observe(map(payload))));
  };

  const traced = (
    payload: Readonly<Record<string, unknown>>,
    taskId: string | null,
    boardId?: string | undefined,
  ): Readonly<Record<string, unknown>> => ({
    ...payload,
    trace: input.trace.snapshot(taskId, boardId),
  });

  on('agent.run.started', (event) => ({
    taskId: event.ctx.currentKanbanTaskId ?? null,
    category: 'status_changed',
    observedAt: event.at,
    payload: traced(
      {
        entity: 'agent_run',
        observer: SHADOW_SOURCE,
        phase: 'started',
        model: event.model,
        ...optional('sessionId', event.sessionId),
        ...optional('agentId', event.ctx.agentId),
        ...optional('agentName', event.ctx.agentName),
        ...optional('traceId', event.ctx.traceId),
      },
      event.ctx.currentKanbanTaskId ?? null,
      event.ctx.currentKanbanBoardId,
    ),
  }));
  on('agent.run.completed', (event) => ({
    taskId: event.ctx.currentKanbanTaskId ?? null,
    category: 'status_changed',
    observedAt: event.at,
    payload: traced(
      {
        entity: 'agent_run',
        observer: SHADOW_SOURCE,
        phase: 'completed',
        status: event.status,
        iterations: event.iterations,
        durationMs: event.durationMs,
        ...optional('sessionId', event.sessionId),
        ...optional('agentId', event.ctx.agentId),
        ...optional('agentName', event.ctx.agentName),
        ...optional('traceId', event.ctx.traceId),
      },
      event.ctx.currentKanbanTaskId ?? null,
      event.ctx.currentKanbanBoardId,
    ),
  }));
  on('agent.run.error', (event) => ({
    taskId: event.ctx.currentKanbanTaskId ?? null,
    category: 'failure_reported',
    observedAt: event.at,
    payload: traced(
      {
        entity: 'agent_run',
        observer: SHADOW_SOURCE,
        phase: 'error',
        durationMs: event.durationMs,
        errorName: event.err.name,
        ...optional('sessionId', event.sessionId),
        ...optional('agentId', event.ctx.agentId),
        ...optional('agentName', event.ctx.agentName),
        ...optional('traceId', event.ctx.traceId),
      },
      event.ctx.currentKanbanTaskId ?? null,
      event.ctx.currentKanbanBoardId,
    ),
  }));
  on('tool.started', (event) => ({
    taskId: event.taskId ?? null,
    category: 'tool_invoked',
    observedAt: new Date().toISOString(),
    payload: traced(
      {
        phase: 'started',
        observer: SHADOW_SOURCE,
        toolCallId: event.id,
        toolName: event.name,
        ...optional('sessionId', event.sessionId),
        ...optional('traceId', event.traceId),
        ...optional('agentId', event.agentId),
        ...optional('agentName', event.agentName),
        ...optional('boardId', event.boardId),
        ...optional('provider', event.provider),
        ...optional('model', event.model),
      },
      event.taskId ?? null,
      event.boardId,
    ),
  }));
  on('permission.evaluated', (event) => ({
    taskId: event.taskId ?? null,
    category: 'tool_invoked',
    observedAt: new Date().toISOString(),
    payload: traced(
      {
        phase: 'authorized',
        observer: SHADOW_SOURCE,
        toolCallId: event.id,
        toolName: event.name,
        inputHash: event.inputHash,
        policyDecision: event.policyDecision,
        effectiveDecision: event.effectiveDecision,
        decisionSource: event.decisionSource,
        yoloEnabled: event.yoloEnabled,
        capabilityDowngraded: event.capabilityDowngraded,
        ...optional('sessionId', event.sessionId),
        ...optional('traceId', event.traceId),
        ...optional('agentId', event.agentId),
        ...optional('riskTier', event.riskTier),
        ...optional('boundaryDecision', event.boundaryDecision),
        ...optional('boardId', event.boardId),
        ...optional('provider', event.provider),
        ...optional('model', event.model),
      },
      event.taskId ?? null,
      event.boardId,
    ),
  }));
  on('tool.executed', (event) => ({
    taskId: event.taskId ?? null,
    category: 'tool_invoked',
    observedAt: new Date().toISOString(),
    payload: traced(
      {
        phase: 'completed',
        observer: SHADOW_SOURCE,
        toolName: event.name,
        durationMs: event.durationMs,
        ok: event.ok,
        ...optional('mutating', event.mutating),
        ...optional('toolCallId', event.id),
        ...optional('sessionId', event.sessionId),
        ...optional('traceId', event.traceId),
        ...optional('agentId', event.agentId),
        ...optional('agentName', event.agentName),
        ...optional('outputBytes', event.outputBytes),
        ...optional('outputTokens', event.outputTokens),
        ...optional('outputLines', event.outputLines),
        ...optional('boardId', event.boardId),
        ...optional('provider', event.provider),
        ...optional('model', event.model),
      },
      event.taskId ?? null,
      event.boardId,
    ),
  }));
  on('tool.executed', (event) => {
    const trace = input.trace.snapshot(event.taskId ?? null, event.boardId);
    return {
      taskId: event.taskId ?? null,
      category: 'evidence_candidate',
      observedAt: new Date().toISOString(),
      payload: {
        observer: SHADOW_SOURCE,
        ...createGovernanceEvidenceCandidate(trace, {
          toolCallId: event.id,
          toolName: event.name,
          ok: event.ok,
          durationMs: event.durationMs,
          outputBytes: event.outputBytes,
          outputTokens: event.outputTokens,
          outputLines: event.outputLines,
        }),
        trace,
      },
    };
  });

  on('checkpoint.written', (event) => {
    input.trace.updateWorkspaceCheckpoint(event.promptIndex, event.ts, event.workspaceCheckpoint);
    return {
      taskId: null,
      category: 'status_changed',
      observedAt: event.ts,
      payload: traced(
        {
          entity: 'workspace_checkpoint',
          observer: SHADOW_SOURCE,
          phase: 'captured',
          promptIndex: event.promptIndex,
          fileCount: event.fileCount,
        },
        null,
      ),
    };
  });
  disposers.push(
    input.events.on('storage.write', (event) => {
      if (
        event.store !== 'plan' ||
        event.outcome !== 'success' ||
        !input.trace.matchesPlanPath(event.filePath)
      ) {
        return;
      }
      void input.trace.refreshPlan().then((plan) => {
        observe({
          taskId: null,
          category: 'plan_updated',
          observedAt: new Date().toISOString(),
          payload: traced(
            {
              entity: 'session_plan',
              observer: SHADOW_SOURCE,
              phase: 'persisted',
              plan,
            },
            null,
          ),
        });
      });
    }),
  );

  return Object.freeze({
    close: () => {
      if (closed) return;
      closed = true;
      for (const dispose of disposers.splice(0)) dispose();
    },
  });
}
