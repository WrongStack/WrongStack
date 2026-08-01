import { EventBus } from '@wrongstack/core/kernel';
import type { GovernanceRuntimeObservationInput } from '@wrongstack/runtime/governance-bootstrap';
import { describe, expect, it, vi } from 'vitest';
import { createGovernanceShadowBridge } from '../src/boot/governance-shadow-bridge.js';
import type { GovernanceTraceContext } from '../src/boot/governance-trace-context.js';

function recordedObservation() {
  return {
    recorded: true as const,
    observationId: 'observation-1',
    idempotentReplay: false,
    sequence: 1,
  };
}

function traceContext(): GovernanceTraceContext {
  return {
    matchesPlanPath: vi.fn(() => false),
    refreshPlan: vi.fn(async () => ({ state: 'missing' as const })),
    updateWorkspaceCheckpoint: vi.fn(),
    snapshot: vi.fn((taskId: string | null, boardId?: string) => ({
      sessionId: 'session-1',
      task: taskId
        ? { scope: 'kanban_task' as const, taskId, boardId: boardId ?? null }
        : { scope: 'session' as const },
      plan: { state: 'missing' as const },
      workspace: { state: 'not_captured' as const },
    })),
  };
}

describe('CLI governance shadow bridge', () => {
  it('records safe agent and tool metadata without forwarding model text or tool bodies', async () => {
    const events = new EventBus();
    const observe = vi.fn(async (_input: GovernanceRuntimeObservationInput) =>
      recordedObservation(),
    );
    const logger = { warn: vi.fn() };
    const bridge = createGovernanceShadowBridge({
      events,
      sink: { observe },
      logger,
      trace: traceContext(),
    });
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
      policyDecision: 'auto',
      effectiveDecision: 'auto',
      decisionSource: 'default',
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
        effectiveDecision: 'auto',
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
    const observe = vi.fn(async (_input: GovernanceRuntimeObservationInput) => ({
      recorded: false as const,
      code: 'request_failed' as const,
      message: 'daemon unavailable',
    }));
    const logger = { warn: vi.fn() };
    const bridge = createGovernanceShadowBridge({
      events,
      sink: { observe },
      logger,
      trace: traceContext(),
    });
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

  it('tracks deterministic workspace checkpoints and persisted plan refreshes', async () => {
    const events = new EventBus();
    const observe = vi.fn(async (_input: GovernanceRuntimeObservationInput) =>
      recordedObservation(),
    );
    const updateWorkspaceCheckpoint = vi.fn();
    const refreshPlan = vi.fn(async () => ({
      state: 'available' as const,
      schemaVersion: 1 as const,
      fingerprint: 'c'.repeat(64),
      observedAt: '2026-08-02T12:00:01.000Z',
      itemCount: 1,
      openCount: 0,
      inProgressCount: 1,
      doneCount: 0,
      activeStepIds: ['step-1'],
      activeStepIdsTruncated: false,
    }));
    const trace: GovernanceTraceContext = {
      matchesPlanPath: vi.fn((candidate) => candidate === 'D:/project/session.plan.json'),
      refreshPlan,
      updateWorkspaceCheckpoint,
      snapshot: vi.fn(() => ({
        sessionId: 'session-1',
        task: { scope: 'session' as const },
        plan: { state: 'missing' as const },
        workspace: { state: 'not_captured' as const },
      })),
    };
    const bridge = createGovernanceShadowBridge({
      events,
      sink: { observe },
      logger: { warn: vi.fn() },
      trace,
    });
    const workspaceCheckpoint = {
      manifestHash: 'a'.repeat(64),
      baseHead: 'b'.repeat(40),
      entryCount: 2,
      unresolvedCount: 0,
      capturedAt: '2026-08-02T12:00:00.000Z',
      coverage: 'git-head-plus-dirty' as const,
    };

    events.emit('checkpoint.written', {
      sessionId: 'session-1',
      promptIndex: 2,
      promptPreview: 'secret prompt preview',
      ts: '2026-08-02T12:00:00.000Z',
      fileCount: 3,
      workspaceCheckpoint,
    });
    events.emit('storage.write', {
      sessionId: 'session-1',
      store: 'plan',
      filePath: 'D:/project/session.plan.json',
      operation: 'save',
      outcome: 'success',
      durationMs: 2,
    });
    await Promise.resolve();

    expect(updateWorkspaceCheckpoint).toHaveBeenCalledWith(
      2,
      '2026-08-02T12:00:00.000Z',
      workspaceCheckpoint,
    );
    expect(refreshPlan).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe.mock.calls.map(([entry]) => entry.category)).toEqual([
      'status_changed',
      'plan_updated',
    ]);
    expect(JSON.stringify(observe.mock.calls)).not.toContain('secret prompt preview');
    bridge.close();
  });
});
