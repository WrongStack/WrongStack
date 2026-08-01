import type { EventBus, EventMap, EventName } from '@wrongstack/core/kernel';
import type {
  GovernanceRuntimeObservationInput,
  GovernanceRuntimeObservationResult,
} from '@wrongstack/runtime/governance-bootstrap';

const SHADOW_SOURCE = 'wrongstack.cli.shadow.v1';

export interface GovernanceObservationSink {
  observe(input: GovernanceRuntimeObservationInput): Promise<GovernanceRuntimeObservationResult>;
}

export interface GovernanceShadowLogger {
  warn(message: string, context?: unknown): void;
}

export interface GovernanceShadowBridge {
  close(): void;
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

export function createGovernanceShadowBridge(input: {
  readonly events: EventBus;
  readonly sink: GovernanceObservationSink;
  readonly logger: GovernanceShadowLogger;
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

  on('agent.run.started', (event) => ({
    taskId: event.ctx.currentKanbanTaskId ?? null,
    source: SHADOW_SOURCE,
    category: 'status_changed',
    observedAt: event.at,
    payload: {
      entity: 'agent_run',
      phase: 'started',
      model: event.model,
      ...optional('sessionId', event.sessionId),
      ...optional('agentId', event.ctx.agentId),
      ...optional('agentName', event.ctx.agentName),
      ...optional('traceId', event.ctx.traceId),
    },
  }));
  on('agent.run.completed', (event) => ({
    taskId: event.ctx.currentKanbanTaskId ?? null,
    source: SHADOW_SOURCE,
    category: 'status_changed',
    observedAt: event.at,
    payload: {
      entity: 'agent_run',
      phase: 'completed',
      status: event.status,
      iterations: event.iterations,
      durationMs: event.durationMs,
      ...optional('sessionId', event.sessionId),
      ...optional('agentId', event.ctx.agentId),
      ...optional('agentName', event.ctx.agentName),
      ...optional('traceId', event.ctx.traceId),
    },
  }));
  on('agent.run.error', (event) => ({
    taskId: event.ctx.currentKanbanTaskId ?? null,
    source: SHADOW_SOURCE,
    category: 'failure_reported',
    observedAt: event.at,
    payload: {
      entity: 'agent_run',
      phase: 'error',
      durationMs: event.durationMs,
      errorName: event.err.name,
      ...optional('sessionId', event.sessionId),
      ...optional('agentId', event.ctx.agentId),
      ...optional('agentName', event.ctx.agentName),
      ...optional('traceId', event.ctx.traceId),
    },
  }));
  on('tool.started', (event) => ({
    taskId: event.taskId ?? null,
    source: SHADOW_SOURCE,
    category: 'tool_invoked',
    observedAt: new Date().toISOString(),
    payload: {
      phase: 'started',
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
  }));
  on('permission.evaluated', (event) => ({
    taskId: event.taskId ?? null,
    source: SHADOW_SOURCE,
    category: 'tool_invoked',
    observedAt: new Date().toISOString(),
    payload: {
      phase: 'authorized',
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
  }));
  on('tool.executed', (event) => ({
    taskId: event.taskId ?? null,
    source: SHADOW_SOURCE,
    category: 'tool_invoked',
    observedAt: new Date().toISOString(),
    payload: {
      phase: 'completed',
      toolName: event.name,
      durationMs: event.durationMs,
      ok: event.ok,
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
  }));

  return Object.freeze({
    close: () => {
      if (closed) return;
      closed = true;
      for (const dispose of disposers.splice(0)) dispose();
    },
  });
}
