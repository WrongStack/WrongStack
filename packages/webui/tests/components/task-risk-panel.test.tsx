import { render, screen } from '@testing-library/react';
import type { KanbanBoard, KanbanEvent, KanbanTask } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import { analyzeTaskRisk, TaskRiskPanel } from '../../src/components/TaskRiskPanel.js';

const dependency: KanbanTask = {
  id: 'dependency-1',
  title: 'Pending dependency',
  columnId: 'todo',
  order: 0,
  priority: 'high',
  status: 'ready',
  createdAt: '2026-07-17T08:00:00.000Z',
  updatedAt: '2026-07-17T08:00:00.000Z',
};

const riskyTask: KanbanTask = {
  id: 'task-risky',
  title: 'Prematurely completed task',
  columnId: 'done',
  order: 0,
  priority: 'critical',
  status: 'completed',
  dependsOn: [dependency.id, 'missing-dependency'],
  successCriteria: [
    { id: 'check-failed', description: 'Tests pass', type: 'test', status: 'failed' },
    { id: 'check-pending', description: 'Reviewer approves', type: 'review', status: 'pending' },
  ],
  assignment: {
    agentId: 'agent-1',
    status: 'completed',
    modelRouting: 'fixed',
    provider: 'openai',
    model: 'gpt-5.4',
    attempt: 1,
    maxAttempts: 1,
  },
  createdAt: '2026-07-17T08:00:00.000Z',
  updatedAt: '2026-07-17T09:00:00.000Z',
};

const board: KanbanBoard = {
  id: 'board-1',
  title: 'Risk board',
  columns: [
    { id: 'todo', title: 'Todo', order: 0 },
    { id: 'done', title: 'Done', order: 1 },
  ],
  tasks: [riskyTask, dependency],
  createdAt: '2026-07-17T08:00:00.000Z',
  updatedAt: '2026-07-17T09:00:00.000Z',
  version: 1,
};

// Deliberately unattributed: the panel scores "how much of this task's history
// can be traced back to an actor and a session", and this fixture is the
// legacy shape it has to warn about. The cast is the point — well-typed events
// always carry a session now, but events already on disk from before the
// invariant do not, and the panel still has to read them.
const sparseEvents = [
  {
    id: 'created',
    boardId: board.id,
    taskId: riskyTask.id,
    type: 'task.created',
    ts: '2026-07-17T08:00:00.000Z',
  },
  {
    id: 'assigned',
    boardId: board.id,
    taskId: riskyTask.id,
    type: 'task.assigned',
    ts: '2026-07-17T08:10:00.000Z',
    after: { status: 'queued', modelRouting: 'fixed', provider: 'openai', model: 'gpt-5.4' },
  },
  {
    id: 'completed',
    boardId: board.id,
    taskId: riskyTask.id,
    type: 'task.assignment.completed',
    ts: '2026-07-17T09:00:00.000Z',
    after: { status: 'completed' },
  },
] as unknown as KanbanEvent[];

describe('TaskRiskPanel', () => {
  it('detects operational contradictions and incomplete audit evidence', () => {
    const assessment = analyzeTaskRisk(
      board,
      riskyTask,
      sparseEvents,
      new Date('2026-07-17T10:00:00.000Z'),
    );
    const ids = assessment.findings.map((finding) => finding.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        'missing-dependency',
        'unresolved-dependency',
        'failed-checks',
        'completed-with-pending-checks',
        'actor-coverage',
        'session-coverage',
        'reason-coverage',
        'missing-terminal-evidence',
      ]),
    );
    expect(assessment.score).toBe(55);
    expect(assessment.coverage).toMatchObject({
      durableEvents: 3,
      actorPercent: 0,
      sessionPercent: 0,
      reasonPercent: 0,
      hasExecutionRoute: true,
      hasTerminalEvidence: false,
    });
  });

  it('gives complete, consistent task evidence a clean audit score', () => {
    const healthyTask: KanbanTask = {
      ...riskyTask,
      id: 'task-healthy',
      dependsOn: [],
      successCriteria: [{ id: 'check', description: 'Tests pass', type: 'test', status: 'passed' }],
      assignment: { ...riskyTask.assignment!, lastResult: 'Release verified.' },
    };
    const healthyBoard = { ...board, tasks: [healthyTask] };
    const healthyEvents: KanbanEvent[] = [
      { ...sparseEvents[0]!, id: 'healthy-created', taskId: healthyTask.id },
      {
        ...sparseEvents[1]!,
        id: 'healthy-assigned',
        taskId: healthyTask.id,
        actor: 'agent-1',
        sessionId: 'session-1',
        note: 'Assigned for release verification.',
      },
      {
        ...sparseEvents[2]!,
        id: 'healthy-completed',
        taskId: healthyTask.id,
        actor: 'agent-1',
        sessionId: 'session-1',
        note: 'Release verified.',
      },
    ];

    const assessment = analyzeTaskRisk(healthyBoard, healthyTask, healthyEvents);
    expect(assessment.score).toBe(100);
    expect(assessment.findings).toEqual([]);
  });

  it('renders score, coverage, severity, remediation, and risk details', () => {
    render(<TaskRiskPanel board={board} task={riskyTask} events={sparseEvents} />);

    expect(screen.getByText('Risk & audit quality')).toBeTruthy();
    expect(screen.getByText('audit 55/100')).toBeTruthy();
    expect(screen.getByText('Dependency references are broken')).toBeTruthy();
    expect(screen.getByText('Terminal run has no result or error evidence')).toBeTruthy();
    expect(screen.getAllByText(/Next:/).length).toBeGreaterThan(0);
  });
});
