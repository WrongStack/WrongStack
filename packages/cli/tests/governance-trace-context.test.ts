import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createGovernanceTraceContext,
  MAX_GOVERNANCE_PLAN_BYTES,
} from '../src/boot/governance-trace-context.js';

describe('CLI governance trace context', () => {
  it('binds persisted plan and workspace identities without exposing plan text', async () => {
    const secret = 'secret plan title and implementation details';
    const raw = JSON.stringify({
      version: 1,
      sessionId: 'session-1',
      title: secret,
      updatedAt: '2026-08-02T12:00:00.000Z',
      items: [
        {
          id: 'step-open',
          title: secret,
          details: secret,
          status: 'open',
        },
        { id: 'step-active', title: secret, status: 'in_progress' },
        { id: 'step-done', title: secret, status: 'done' },
      ],
    });
    const trace = await createGovernanceTraceContext(
      { sessionId: 'session-1', planPath: 'D:/project/.wrongstack/session.plan.json' },
      {
        readFile: async () => raw,
        now: () => '2026-08-02T12:00:01.000Z',
      },
    );
    trace.updateWorkspaceCheckpoint(3, '2026-08-02T12:00:02.000Z', {
      manifestHash: 'a'.repeat(64),
      baseHead: 'b'.repeat(40),
      entryCount: 2,
      unresolvedCount: 0,
      capturedAt: '2026-08-02T12:00:02.000Z',
      coverage: 'git-head-plus-dirty',
    });

    const snapshot = trace.snapshot('task-1', 'board-1');
    expect(snapshot).toEqual({
      sessionId: 'session-1',
      task: { scope: 'kanban_task', taskId: 'task-1', boardId: 'board-1' },
      plan: {
        state: 'available',
        schemaVersion: 1,
        fingerprint: createHash('sha256').update(raw, 'utf8').digest('hex'),
        updatedAt: '2026-08-02T12:00:00.000Z',
        observedAt: '2026-08-02T12:00:01.000Z',
        itemCount: 3,
        openCount: 1,
        inProgressCount: 1,
        doneCount: 1,
        activeStepIds: ['step-active'],
        activeStepIdsTruncated: false,
      },
      workspace: {
        state: 'captured',
        promptIndex: 3,
        manifestHash: 'a'.repeat(64),
        baseHead: 'b'.repeat(40),
        entryCount: 2,
        unresolvedCount: 0,
        capturedAt: '2026-08-02T12:00:02.000Z',
        coverage: 'git-head-plus-dirty',
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  it('keeps missing and invalid plan state explicit instead of inventing a version', async () => {
    const missing = await createGovernanceTraceContext(
      { sessionId: 'session-1', planPath: 'D:/project/missing.plan.json' },
      {
        readFile: async () => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
        now: () => '2026-08-02T12:00:00.000Z',
      },
    );
    const invalid = await createGovernanceTraceContext(
      { sessionId: 'session-1', planPath: 'D:/project/invalid.plan.json' },
      {
        readFile: async () => JSON.stringify({ version: 1, items: [{ id: 'step-1' }] }),
        now: () => '2026-08-02T12:00:00.000Z',
      },
    );

    expect(missing.snapshot(null).plan).toEqual({ state: 'missing' });
    expect(invalid.snapshot(null).plan).toEqual({ state: 'invalid' });
    missing.updateWorkspaceCheckpoint(1, '2026-08-02T12:00:01.000Z', undefined);
    expect(missing.snapshot(null).workspace).toEqual({
      state: 'unavailable',
      promptIndex: 1,
      observedAt: '2026-08-02T12:00:01.000Z',
    });
  });

  it('refuses to fingerprint an oversized plan sidecar', async () => {
    const trace = await createGovernanceTraceContext(
      { sessionId: 'session-1', planPath: 'D:/project/large.plan.json' },
      {
        readFile: async () => 'x'.repeat(MAX_GOVERNANCE_PLAN_BYTES + 1),
        now: () => '2026-08-02T12:00:00.000Z',
      },
    );

    expect(trace.snapshot(null).plan).toEqual({ state: 'unreadable' });
  });
});
