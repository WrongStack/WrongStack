// Tests for the TUI-side Kanban Cleaner audit. The audit vocabulary must
// stay in lock-step with the WebUI's `packages/webui/src/lib/kanban-cleaner.ts`
// so a board audited from either surface produces the same findings.

import type { KanbanAgentAssignment, KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import {
  auditKanbanBoard,
  type KanbanAuditIssue,
  type KanbanAuditSummary,
  summarizeAuditHeadline,
  topAuditIssues,
} from '../src/kanban-audit.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date('2026-07-18T12:00:00.000Z');
const STALE_REVIEW_AT = '2026-07-15T06:00:00.000Z'; // 78h before NOW > 72h

function task(id: string, overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id,
    title: `Task ${id}`,
    columnId: 'todo',
    order: 0,
    priority: 'medium',
    status: 'pending',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    description: 'pre-filled description',
    successCriteria: [{ id: 'c', description: 'x', type: 'manual', status: 'pending' }],
    assignedAgent: 'core-builder',
    ...overrides,
  };
}

function board(tasks: KanbanTask[]): KanbanBoard {
  return {
    id: 'b-audit',
    title: 'Audit fixtures',
    columns: [
      { id: 'todo', title: 'To Do', order: 0 },
      { id: 'review', title: 'Review', order: 1 },
    ],
    tasks,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    version: 1,
  };
}

function assignment(overrides: Partial<KanbanAgentAssignment> = {}): KanbanAgentAssignment {
  return {
    status: 'running',
    agentId: 'agent-1',
    subagentId: 'sub-1',
    leaseId: 'lease-1',
    claimedAt: NOW.toISOString(),
    heartbeatAt: NOW.toISOString(),
    leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    ...overrides,
  };
}

// ── auditKanbanBoard — every code path produces at least one issue ───────────

describe('auditKanbanBoard — code coverage', () => {
  it('flags missing-description', () => {
    const t = task('t1', { description: undefined });
    const summary = auditKanbanBoard(board([t]), { now: NOW });
    expect(summary.issues.some((i) => i.code === 'missing-description')).toBe(true);
  });

  it('flags missing-assignee when no assigned agent and no assignment identities', () => {
    const t = task('t1', { assignedAgent: undefined, assignee: undefined });
    const summary = auditKanbanBoard(board([t]), { now: NOW });
    expect(summary.issues.some((i) => i.code === 'missing-assignee')).toBe(true);
  });

  it('omits missing-assignee when an assignment.agentId is set', () => {
    // Clear the default `assignedAgent: 'core-builder'` set by the task
    // helper — otherwise the audit's `assignmentIdentities` helper picks
    // up that fallback and the test passes even when the
    // assignment-only branch is broken.
    const t = task('t1', {
      assignedAgent: undefined,
      assignee: undefined,
      assignment: assignment({ agentId: 'someone' }),
    });
    const summary = auditKanbanBoard(board([t]), {
      now: NOW,
      liveAgentIdentities: ['someone'],
    });
    expect(summary.issues.some((i) => i.code === 'missing-assignee')).toBe(false);
  });

  it('flags missing-due-date only when requireDueDate is true', () => {
    const t = task('t1');
    const withoutFlag = auditKanbanBoard(board([t]), { now: NOW });
    expect(withoutFlag.issues.some((i) => i.code === 'missing-due-date')).toBe(false);
    const withFlag = auditKanbanBoard(board([t]), {
      now: NOW,
      requireDueDate: true,
    });
    expect(withFlag.issues.some((i) => i.code === 'missing-due-date')).toBe(true);
  });

  it('auto-enables requireDueDate on managed boards even when caller omits the flag', () => {
    // Regression: managed lifecycle boards always require a due date —
    // the WebUI Cleaner enables this by reading the lifecycle policy,
    // and the TUI must do the same so the two surfaces agree. The
    // caller must NOT have to set requireDueDate explicitly.
    const t = task('t1'); // no dueDate, no labels
    const legacy = board([t]);
    expect(
      auditKanbanBoard(legacy, { now: NOW }).issues.some((i) => i.code === 'missing-due-date'),
    ).toBe(false);
    const managed: KanbanBoard = {
      ...board([t]),
      lifecycle: {
        mode: 'managed',
        columns: {
          backlog: 'backlog',
          todo: 'todo',
          running: 'running',
          review: 'review',
          done: 'done',
        },
      },
    };
    expect(
      auditKanbanBoard(managed, { now: NOW }).issues.some((i) => i.code === 'missing-due-date'),
    ).toBe(true);
  });

  it('does not allow callers to disable required due dates on managed boards', () => {
    // The managed lifecycle validator always requires a valid due date;
    // audit options may opt legacy boards in, but cannot weaken that contract.
    const t = task('t1');
    const managed: KanbanBoard = {
      ...board([t]),
      lifecycle: {
        mode: 'managed',
        columns: {
          backlog: 'backlog',
          todo: 'todo',
          running: 'running',
          review: 'review',
          done: 'done',
        },
      },
    };
    expect(
      auditKanbanBoard(managed, { now: NOW, requireDueDate: false }).issues.some(
        (i) => i.code === 'missing-due-date',
      ),
    ).toBe(true);
  });

  it('flags missing-labels when labels are empty', () => {
    const t = task('t1', { labels: undefined });
    const summary = auditKanbanBoard(board([t]), { now: NOW });
    expect(summary.issues.some((i) => i.code === 'missing-labels')).toBe(true);
  });

  it('omits missing-labels when labels are present', () => {
    const t = task('t1', { labels: ['feature:auth'] });
    const summary = auditKanbanBoard(board([t]), { now: NOW });
    expect(summary.issues.some((i) => i.code === 'missing-labels')).toBe(false);
  });

  it('flags missing-subtasks when childTaskIds and subtasks are both empty', () => {
    const t = task('t1');
    const summary = auditKanbanBoard(board([t]), { now: NOW });
    expect(summary.issues.some((i) => i.code === 'missing-subtasks')).toBe(true);
  });

  it('flags missing-success-criteria when no checks exist', () => {
    const t = task('t1', { successCriteria: undefined });
    const summary = auditKanbanBoard(board([t]), { now: NOW });
    expect(summary.issues.some((i) => i.code === 'missing-success-criteria')).toBe(true);
  });

  it('requires authoritative managed detail fields instead of legacy substitutes', () => {
    const t = task('t1', {
      dueDate: NOW.toISOString(),
      labels: undefined,
      childTaskIds: undefined,
      successCriteria: ['legacy criterion'] as unknown as KanbanTask['successCriteria'],
    });
    const legacyTask = t as KanbanTask & { tags?: string[]; subtasks?: string[] };
    legacyTask.tags = ['legacy-tag'];
    legacyTask.subtasks = ['legacy-subtask'];
    const legacyCodes = auditKanbanBoard(board([legacyTask]), { now: NOW }).issues.map(
      (issue) => issue.code,
    );
    expect(legacyCodes).not.toContain('missing-labels');
    expect(legacyCodes).not.toContain('missing-subtasks');
    expect(legacyCodes).not.toContain('missing-success-criteria');

    const managed: KanbanBoard = {
      ...board([legacyTask]),
      lifecycle: {
        mode: 'managed',
        columns: {
          backlog: 'backlog',
          todo: 'todo',
          running: 'running',
          review: 'review',
          done: 'done',
        },
      },
    };
    const managedCodes = auditKanbanBoard(managed, { now: NOW }).issues.map((issue) => issue.code);
    expect(managedCodes).toEqual(
      expect.arrayContaining(['missing-labels', 'missing-subtasks', 'missing-success-criteria']),
    );
  });

  it('rejects malformed managed details instead of accepting non-empty containers', () => {
    const t = task('t1', {
      dueDate: 'not-a-date',
      labels: ['   '],
      childTaskIds: [''],
      successCriteria: [{ id: 'c', description: ' ', type: 'manual', status: 'pending' }],
    });
    const managed: KanbanBoard = {
      ...board([t]),
      lifecycle: {
        mode: 'managed',
        columns: {
          backlog: 'backlog',
          todo: 'todo',
          running: 'running',
          review: 'review',
          done: 'done',
        },
      },
    };
    const codes = auditKanbanBoard(managed, { now: NOW }).issues.map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'missing-due-date',
        'missing-labels',
        'missing-subtasks',
        'missing-success-criteria',
      ]),
    );
  });

  it.each([
    ['non-running status', { status: 'queued' as const }],
    ['missing claim timestamp', { claimedAt: '' }],
    ['missing heartbeat timestamp', { heartbeatAt: '' }],
  ])('flags abandoned-running-task for %s', (_label, invalidAssignment) => {
    const t = task('t1', {
      status: 'in_progress',
      assignment: assignment(invalidAssignment),
    });
    const summary = auditKanbanBoard(board([t]), { now: NOW });
    expect(summary.issues.some((i) => i.code === 'abandoned-running-task')).toBe(true);
  });

  it('flags abandoned-running-task when a running task has no leaseId', () => {
    const t = task('t1', {
      status: 'in_progress',
      assignment: assignment({ leaseId: '' }),
    });
    const summary = auditKanbanBoard(board([t]), { now: NOW });
    const issues = summary.issues.filter((i) => i.code === 'abandoned-running-task');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.severity).toBe('error');
  });

  it('distinguishes an unavailable live roster from an authoritative empty roster', () => {
    const t = task('t1', {
      status: 'in_progress',
      assignedAgent: undefined,
      assignment: assignment(),
    });

    const unavailable = auditKanbanBoard(board([t]), { now: NOW });
    expect(unavailable.issues.some((i) => i.code === 'abandoned-running-task')).toBe(false);

    const noAgentsLive = auditKanbanBoard(board([t]), {
      now: NOW,
      liveAgentIdentities: [],
    });
    expect(noAgentsLive.issues.some((i) => i.code === 'abandoned-running-task')).toBe(true);
  });

  it('flags abandoned-running-task when the assigned agent is not in a populated roster', () => {
    const t = task('t1', {
      status: 'in_progress',
      assignedAgent: undefined,
      assignment: assignment({
        leaseId: 'lease-2',
        leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        agentId: 'core-builder',
      }),
    });
    const summary = auditKanbanBoard(board([t]), {
      now: NOW,
      liveAgentIdentities: ['some-other-agent'],
    });
    expect(summary.issues.some((i) => i.code === 'abandoned-running-task')).toBe(true);
  });

  it('flags stale-running-task when the lease expires in the past', () => {
    const t = task('t1', {
      status: 'in_progress',
      assignment: assignment({
        leaseExpiresAt: new Date(NOW.getTime() - 60_000).toISOString(),
      }),
    });
    const summary = auditKanbanBoard(board([t]), { now: NOW });
    const issues = summary.issues.filter((i) => i.code === 'stale-running-task');
    expect(issues.length).toBe(1);
    expect(issues[0]?.severity).toBe('error');
  });

  it('flags stale-review when the task has been in review past the 72h threshold', () => {
    const t = task('t1', {
      status: 'review',
      updatedAt: STALE_REVIEW_AT,
    });
    const summary = auditKanbanBoard(board([t]), { now: NOW });
    const issues = summary.issues.filter((i) => i.code === 'stale-review');
    expect(issues.length).toBe(1);
    expect(issues[0]?.severity).toBe('warning');
  });

  it('does not flag a fresh review task', () => {
    const t = task('t1', { status: 'review' });
    const summary = auditKanbanBoard(board([t]), { now: NOW });
    expect(summary.issues.some((i) => i.code === 'stale-review')).toBe(false);
  });

  it('flags canonical managed lifecycle skips even when columns use custom IDs', () => {
    const t = task('t1', {
      status: 'in_progress',
      columnId: 'c4',
      lifecycle: {
        currentStage: 'review',
        stageEnteredAt: NOW.toISOString(),
        history: [
          { to: 'backlog', at: '2026-07-10T00:00:00.000Z', actor: 'system' },
          { from: 'backlog', to: 'review', at: NOW.toISOString(), actor: 'system' },
        ],
      },
    });
    const boardWithPolicy: KanbanBoard = {
      ...board([t]),
      lifecycle: {
        mode: 'managed',
        columns: {
          backlog: 'c1',
          todo: 'c2',
          running: 'c3',
          review: 'c4',
          done: 'c5',
        },
      },
    };
    const summary = auditKanbanBoard(boardWithPolicy, { now: NOW });
    expect(summary.issues.some((i) => i.code === 'skipped-lifecycle-state')).toBe(true);
  });

  it('validates lifecycle history before suppressing completed task details', () => {
    const t = task('done', {
      status: 'completed',
      columnId: 'c5',
      lifecycle: {
        currentStage: 'done',
        stageEnteredAt: NOW.toISOString(),
        history: [
          { to: 'backlog', at: '2026-07-10T00:00:00.000Z', actor: 'system' },
          { from: 'backlog', to: 'done', at: NOW.toISOString(), actor: 'system' },
        ],
      },
    });
    const managed: KanbanBoard = {
      ...board([t]),
      lifecycle: {
        mode: 'managed',
        columns: { backlog: 'c1', todo: 'c2', running: 'c3', review: 'c4', done: 'c5' },
      },
    };
    const summary = auditKanbanBoard(managed, { now: NOW });
    expect(summary.issues.map((issue) => issue.code)).toEqual(['skipped-lifecycle-state']);
  });

  it('requires due dates by default on managed boards', () => {
    const managed: KanbanBoard = {
      ...board([task('t1')]),
      lifecycle: {
        mode: 'managed',
        columns: { backlog: 'c1', todo: 'c2', running: 'c3', review: 'c4', done: 'c5' },
      },
    };
    const summary = auditKanbanBoard(managed, { now: NOW });
    expect(summary.issues.some((issue) => issue.code === 'missing-due-date')).toBe(true);
  });

  it('does not infer an abandoned agent when no live roster was supplied', () => {
    const t = task('t1', { status: 'in_progress', assignment: assignment() });
    const summary = auditKanbanBoard(board([t]), { now: NOW });
    expect(summary.issues.some((issue) => issue.code === 'abandoned-running-task')).toBe(false);
  });

  it('counts error vs warning buckets separately', () => {
    const errorTask = task('t1', {
      status: 'in_progress',
      assignment: assignment({ leaseId: '' }),
    });
    const warnTask = task('t2', { description: undefined });
    const summary = auditKanbanBoard(board([errorTask, warnTask]), { now: NOW });
    expect(summary.counts.error).toBeGreaterThan(0);
    expect(summary.counts.warning).toBeGreaterThan(0);
    expect(summary.affectedTaskCount).toBe(2);
  });

  it('ignores terminal-status tasks (completed/archived) so they never produce issues', () => {
    const t = task('done', {
      status: 'completed',
      description: undefined,
      assignedAgent: undefined,
    });
    const summary = auditKanbanBoard(board([t]), { now: NOW });
    expect(summary.issues.length).toBe(0);
  });

  it('throws on invalid `now` input so callers cannot pass silent garbage', () => {
    expect(() => auditKanbanBoard(board([task('t1')]), { now: new Date('not a date') })).toThrow(
      TypeError,
    );
  });

  it('returns an empty summary for a board with no non-terminal tasks', () => {
    const summary = auditKanbanBoard(board([]), { now: NOW });
    expect(summary.issues.length).toBe(0);
    expect(summary.affectedTaskCount).toBe(0);
  });
});

// ── summary helpers ─────────────────────────────────────────────────────────

describe('summarizeAuditHeadline', () => {
  it('returns null when the summary is empty', () => {
    expect(summarizeAuditHeadline(emptySummary())).toBeNull();
  });

  it('renders the singular form for a single warning', () => {
    const summary = singleIssue('warning', 't', 'Add a description');
    const headline = summarizeAuditHeadline(summary);
    expect(headline).toMatch(/1 cleaner issue/);
    expect(headline).toMatch(/1 warning/);
  });

  it('renders the plural form and error/warning breakdown for a mixed summary', () => {
    const summary: KanbanAuditSummary = {
      ...emptySummary(),
      counts: { error: 2, warning: 3 },
      issues: [
        issue('error'),
        issue('error'),
        issue('warning'),
        issue('warning'),
        issue('warning'),
      ],
    };
    const headline = summarizeAuditHeadline(summary);
    expect(headline).toMatch(/5 cleaner issues/);
    expect(headline).toMatch(/2 error · 3 warning/);
  });
});

describe('topAuditIssues', () => {
  it('returns up to `limit` issues, biased to errors first', () => {
    const summary: KanbanAuditSummary = {
      ...emptySummary(),
      counts: { error: 1, warning: 4 },
      issues: [
        issue('warning'),
        issue('warning'),
        issue('warning'),
        issue('warning'),
        issue('error'),
      ],
    };
    const top = topAuditIssues(summary, 3);
    expect(top.length).toBe(3);
    expect(top[0]?.severity).toBe('error');
    expect(top.slice(1).every((i) => i.severity === 'warning')).toBe(true);
  });

  it('returns the full list when the limit exceeds the issue count', () => {
    const summary = singleIssue('warning', 't', 'msg');
    expect(topAuditIssues(summary, 10).length).toBe(1);
  });
});

// ── Test helpers ────────────────────────────────────────────────────────────

// Empty detail buckets + activity stamps shared by the audit-summary fixtures.
// `KanbanAuditSummary` requires these even when a test only exercises issues.
const EMPTY_AUDIT_BUCKETS = {
  generatedAt: '2026-07-18T12:00:00.000Z',
  boardIds: ['b-1'] as const,
  dependencyBlocked: { count: 0, tasks: [] },
  staleAssignments: { count: 0, tasks: [] },
  failedRetryable: { count: 0, tasks: [] },
  heartbeatDue: { count: 0, tasks: [] },
  lastDispatchedAt: undefined,
  lastStaleRecoveredAt: undefined,
} satisfies Partial<KanbanAuditSummary>;

function emptySummary(): KanbanAuditSummary {
  return {
    ...EMPTY_AUDIT_BUCKETS,
    issues: [],
    counts: { error: 0, warning: 0 },
    affectedTaskCount: 0,
  };
}

function singleIssue(
  severity: KanbanAuditIssue['severity'],
  taskTitle: string,
  message: string,
): KanbanAuditSummary {
  const issued = issue(severity, taskTitle, message);
  return {
    ...EMPTY_AUDIT_BUCKETS,
    issues: [issued],
    counts: { error: severity === 'error' ? 1 : 0, warning: severity === 'warning' ? 1 : 0 },
    affectedTaskCount: 1,
  };
}

function issue(
  severity: KanbanAuditIssue['severity'],
  taskTitle = 'task-1',
  message = 'msg',
): KanbanAuditIssue {
  return {
    id: `t1:${severity}`,
    taskId: 't1',
    taskTitle,
    code: 'missing-description',
    severity,
    message,
  };
}
