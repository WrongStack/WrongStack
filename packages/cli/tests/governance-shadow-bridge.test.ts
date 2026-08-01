import { EventBus } from '@wrongstack/core/kernel';
import { describe, expect, it, vi } from 'vitest';
import { createGovernanceShadowBridge } from '../src/boot/governance-shadow-bridge.js';

function recordedObservation() {
  return {
    recorded: true as const,
    observationId: 'observation-1',
    idempotentReplay: false,
    sequence: 1,
  };
}

describe('CLI governance shadow bridge', () => {
  it('records safe agent and tool metadata without forwarding model text or tool bodies', async () => {
    const events = new EventBus();
    const observe = vi.fn(async () => recordedObservation());
    const logger = { warn: vi.fn() };
    const bridge = createGovernanceShadowBridge({ events, sink: { observe }, logger });
    const secret = 'secret-user-and-tool-content';
    const ctx = {
      currentKanbanTaskId: 'task-1',
      agentId: 'agent-1',
      agentName: 'builder',
      traceId: 'trace-1',
    } as never;

    events.emit('agent.run.started', {
      sessionId: 'session-1',
      ctx,
      model: 'model-1',
      at: '2026-08-02T12:00:00.000Z',
      inputText: secret,
    });
    events.emit('tool.started', {
      sessionId: 'session-1',
      traceId: 'trace-1',
      agentId: 'agent-1',
      agentName: 'builder',
      name: 'shell',
      id: 'tool-1',
      input: { command: secret },
      taskId: 'task-1',
      provider: 'provider-1',
      model: 'model-1',
    });
    events.emit('permission.evaluated', {
      sessionId: 'session-1',
      traceId: 'trace-1',
      agentId: 'agent-1',
      name: 'shell',
      id: 'tool-1',
      inputHash: 'sha256-safe',
      policyDecision: 'allow',
      effectiveDecision: 'allow',
      decisionSource: 'policy',
      reason: secret,
      yoloEnabled: false,
      capabilityDowngraded: false,
      taskId: 'task-1',
    });
    events.emit('tool.executed', {
      sessionId: 'session-1',
      traceId: 'trace-1',
      agentId: 'agent-1',
      agentName: 'builder',
      id: 'tool-1',
      name: 'shell',
      durationMs: 25,
      ok: true,
      input: { command: secret },
      output: secret,
      outputBytes: 128,
      outputTokens: 32,
      taskId: 'task-1',
    });
    events.emit('agent.run.error', {
      sessionId: 'session-1',
      ctx,
      err: new Error(secret),
      at: '2026-08-02T12:00:01.000Z',
      durationMs: 100,
    });

    expect(observe).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(observe.mock.calls)).not.toContain(secret);
    expect(observe.mock.calls[2]?.[0]).toMatchObject({
      taskId: 'task-1',
      category: 'tool_invoked',
      payload: {
        phase: 'authorized',
        toolCallId: 'tool-1',
        inputHash: 'sha256-safe',
        effectiveDecision: 'allow',
      },
    });
    expect(observe.mock.calls[4]?.[0]).toMatchObject({
      category: 'failure_reported',
      payload: { phase: 'error', errorName: 'Error' },
    });
    expect(logger.warn).not.toHaveBeenCalled();
    bridge.close();
  });

  it('fails open, warns once, and removes every listener on close', async () => {
    const events = new EventBus();
    const observe = vi.fn(async () => ({
      recorded: false as const,
      code: 'request_failed' as const,
      message: 'daemon unavailable',
    }));
    const logger = { warn: vi.fn() };
    const bridge = createGovernanceShadowBridge({ events, sink: { observe }, logger });
    const event = {
      name: 'read',
      id: 'tool-1',
    };

    expect(() => events.emit('tool.started', event)).not.toThrow();
    expect(() => events.emit('tool.started', { ...event, id: 'tool-2' })).not.toThrow();
    await Promise.resolve();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    bridge.close();
    events.emit('tool.started', { ...event, id: 'tool-3' });
    expect(observe).toHaveBeenCalledTimes(2);
  });
});
