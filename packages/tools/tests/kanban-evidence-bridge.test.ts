import { describe, expect, it } from 'vitest';
import type { Context } from '@wrongstack/core/agent';
import type { KanbanVerificationReport } from '@wrongstack/kanban';
import {
  kanbanEvidenceKey,
  kanbanEvidencePointer,
  recordKanbanVerificationEvidence,
} from '../src/kanban-evidence-bridge.js';

function report(overrides: Partial<KanbanVerificationReport> = {}): KanbanVerificationReport {
  return {
    taskId: 'task-1',
    taskTitle: 'Gated task',
    boardId: 'board-1',
    startedAt: '2026-07-24T10:00:00.000Z',
    completedAt: '2026-07-24T10:00:05.000Z',
    verdict: 'passed',
    checks: [
      {
        checkId: 'c1',
        description: 'tests pass',
        type: 'test',
        status: 'passed',
        evidence: {},
      },
      {
        checkId: 'c2',
        description: 'manual look',
        type: 'manual',
        status: 'failed',
        evidence: {},
      },
    ],
    markdownSummary: 'summary',
    attachments: [],
    ...overrides,
  };
}

describe('kanban evidence bridge', () => {
  it('writes a ledger entry with the stable key and deep-link pointer', () => {
    const ctx = {} as Context;
    recordKanbanVerificationEvidence(ctx, report());
    const evidence = (ctx as { contextEvidence?: { completedWork: unknown[] } }).contextEvidence;
    expect(evidence?.completedWork).toHaveLength(1);
    expect(evidence?.completedWork[0]).toMatchObject({
      key: kanbanEvidenceKey('board-1', 'task-1'),
      source: 'verification',
      summary: 'Gated task — verification passed (1/2 checks)',
      evidence: kanbanEvidencePointer('board-1', 'task-1'),
      completedAt: Date.parse('2026-07-24T10:00:05.000Z'),
    });
  });

  it('re-verifying the same task updates the entry in place', () => {
    const ctx = {} as Context;
    recordKanbanVerificationEvidence(ctx, report({ verdict: 'failed' }));
    recordKanbanVerificationEvidence(ctx, report({ verdict: 'passed' }));
    const evidence = (ctx as { contextEvidence?: { completedWork: Array<{ summary: string }> } })
      .contextEvidence;
    expect(evidence?.completedWork).toHaveLength(1);
    expect(evidence?.completedWork[0]?.summary).toContain('verification passed');
  });

  it('never throws on a broken context', () => {
    expect(() =>
      recordKanbanVerificationEvidence(null as unknown as Context, report()),
    ).not.toThrow();
  });
});
