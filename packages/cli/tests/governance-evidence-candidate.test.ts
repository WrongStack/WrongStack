import { describe, expect, it } from 'vitest';
import { createGovernanceEvidenceCandidate } from '../src/boot/governance-evidence-candidate.js';
import type { GovernanceTraceContextSnapshot } from '../src/boot/governance-trace-context.js';

function boundTrace(overrides: Partial<GovernanceTraceContextSnapshot> = {}) {
  return {
    sessionId: 'session-1',
    task: { scope: 'kanban_task' as const, taskId: 'task-1', boardId: 'board-1' },
    plan: {
      state: 'available' as const,
      schemaVersion: 1 as const,
      fingerprint: 'a'.repeat(64),
      observedAt: '2026-08-02T12:00:00.000Z',
      itemCount: 1,
      openCount: 0,
      inProgressCount: 1,
      doneCount: 0,
      activeStepIds: ['step-1'],
      activeStepIdsTruncated: false,
    },
    workspace: {
      state: 'captured' as const,
      promptIndex: 1,
      manifestHash: 'b'.repeat(64),
      baseHead: 'c'.repeat(40),
      entryCount: 2,
      unresolvedCount: 0,
      capturedAt: '2026-08-02T12:00:00.000Z',
      coverage: 'git-head-plus-dirty' as const,
    },
    ...overrides,
  } satisfies GovernanceTraceContextSnapshot;
}

describe('governance evidence candidates', () => {
  it('creates a stable unverified identity bound to task, plan, workspace, and tool outcome', () => {
    const input = {
      toolCallId: 'tool-1',
      toolName: 'shell',
      ok: true,
      durationMs: 25,
      outputBytes: 128,
      outputTokens: 32,
      outputLines: 4,
    };

    const first = createGovernanceEvidenceCandidate(boundTrace(), input);
    const replay = createGovernanceEvidenceCandidate(boundTrace(), input);
    const originalTrace = boundTrace();
    if (originalTrace.workspace.state !== 'captured')
      throw new Error('Expected captured workspace.');
    const changedWorkspace = createGovernanceEvidenceCandidate(
      boundTrace({
        workspace: { ...originalTrace.workspace, manifestHash: 'd'.repeat(64) },
      }),
      input,
    );

    expect(first).toMatchObject({
      schemaVersion: 1,
      candidateType: 'tool_execution',
      status: 'unverified',
      binding: { state: 'bound' },
      tool: { callId: 'tool-1', name: 'shell' },
      outcome: { status: 'succeeded', durationMs: 25, outputBytes: 128 },
    });
    expect(first.candidateId).toMatch(/^[a-f0-9]{64}$/);
    expect(replay.candidateId).toBe(first.candidateId);
    expect(changedWorkspace.candidateId).not.toBe(first.candidateId);
  });

  it('records failed outcomes as unverified candidates instead of verification decisions', () => {
    const candidate = createGovernanceEvidenceCandidate(boundTrace(), {
      toolCallId: 'tool-failed',
      toolName: 'shell',
      ok: false,
      durationMs: 10,
    });

    expect(candidate).toMatchObject({
      status: 'unverified',
      outcome: { status: 'failed' },
      binding: { state: 'bound' },
    });
    expect(candidate).not.toHaveProperty('verification');
  });

  it('keeps incomplete bindings explicit and does not invent a candidate identity', () => {
    const secret = 'secret command and output';
    const candidate = createGovernanceEvidenceCandidate(
      {
        sessionId: 'session-1',
        task: { scope: 'session' },
        plan: { state: 'missing' },
        workspace: { state: 'not_captured' },
      },
      {
        toolName: 'shell',
        ok: true,
        durationMs: 5,
      },
    );

    expect(candidate).toMatchObject({
      candidateId: null,
      binding: { state: 'incomplete', missing: ['tool_call', 'task', 'plan', 'workspace'] },
    });
    expect(JSON.stringify(candidate)).not.toContain(secret);
  });
});
