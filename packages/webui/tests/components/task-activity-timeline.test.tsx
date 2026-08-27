import { fireEvent, render, screen } from '@testing-library/react';
import type { KanbanEvent, KanbanTask } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import {
  activityCategory,
  buildTaskActivity,
  buildTaskActivityExport,
  eventFieldChanges,
  TaskActivityTimeline,
} from '../../src/components/TaskActivityTimeline.js';

const task: KanbanTask = {
  id: 'task-1',
  title: 'Audit task activity',
  columnId: 'in-progress',
  order: 0,
  priority: 'high',
  status: 'in_progress',
  createdAt: '2026-07-16T08:00:00.000Z',
  updatedAt: '2026-07-16T08:10:00.000Z',
  assignment: {
    agentId: 'reviewer-1',
    role: 'reviewer',
    status: 'running',
    dispatchedAt: '2026-07-16T08:05:00.000Z',
    subagentId: 'subagent-7',
  },
  notes: [
    {
      id: 'note-1',
      author: 'operator',
      content: 'Keep the event stream durable.',
      createdAt: '2026-07-16T08:08:00.000Z',
    },
  ],
  lifecycle: {
    currentStage: 'running',
    stageEnteredAt: '2026-07-16T08:06:00.000Z',
    history: [
      {
        from: 'todo',
        to: 'running',
        at: '2026-07-16T08:06:00.000Z',
        actor: 'reviewer-1',
        comment: 'Implementation started.',
      },
    ],
  },
};

const events: KanbanEvent[] = [
  {
    id: 'assigned',
    boardId: 'board-1',
    taskId: task.id,
    type: 'task.assigned',
    ts: '2026-07-16T08:05:00.000Z',
    actor: 'reviewer-1',
    sessionId: 'session-42',
    after: { agentId: 'reviewer-1', role: 'reviewer' },
  },
  {
    id: 'other-task',
    boardId: 'board-1',
    taskId: 'task-2',
    type: 'task.created',
    sessionId: 'session-42',
    ts: '2026-07-16T08:09:00.000Z',
  },
];

describe('TaskActivityTimeline', () => {
  it('merges durable events with lifecycle, notes, and a legacy creation fallback', () => {
    const activity = buildTaskActivity(task, events, 'session-42');

    expect(activity.map((event) => event.type)).toEqual([
      'task.note.added',
      'task.lifecycle.transition',
      'task.assigned',
      'task.created',
    ]);
    expect(activity.every((event) => event.taskId === task.id)).toBe(true);
  });

  it('renders agent, session, lifecycle, and note context', () => {
    render(
      <TaskActivityTimeline task={task} events={events} sessionId="session-42" loading={false} />,
    );

    expect(screen.getByRole('region', { name: 'Task activity' })).toBeTruthy();
    expect(screen.getByText('Agent assigned')).toBeTruthy();
    expect(screen.getByText('Lifecycle advanced')).toBeTruthy();
    expect(screen.getByText('Keep the event stream durable.')).toBeTruthy();
    expect(screen.getAllByText('agent:reviewer-1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('session:session-42').length).toBeGreaterThan(0);
  });

  it('renders task-scoped file operations as readable execution evidence', () => {
    const fileRead: KanbanEvent = {
      id: 'file-read',
      boardId: 'board-1',
      taskId: task.id,
      type: 'task.file.read',
      ts: '2026-07-16T08:10:30.000Z',
      actor: 'reviewer-1',
      sessionId: 'session-42',
      correlationId: 'tool-1',
      note: 'read src/app.ts',
      after: {
        operation: 'read',
        filePath: 'src/app.ts',
        toolName: 'read',
        durationMs: 18,
        lines: 64,
      },
    };

    expect(activityCategory(fileRead)).toBe('execution');
    render(<TaskActivityTimeline task={task} events={[...events, fileRead]} />);

    expect(screen.getByText('File Read')).toBeTruthy();
    expect(screen.getByText('src/app.ts · tool:read · 18ms · 64 lines')).toBeTruthy();
    expect(screen.getByText('trace:tool-1')).toBeTruthy();
  });

  it('shows field-level changes, reasons, execution routing, attempts, and raw payloads', () => {
    const update: KanbanEvent = {
      id: 'updated',
      boardId: 'board-1',
      taskId: task.id,
      type: 'task.updated',
      ts: '2026-07-16T08:11:00.000Z',
      actor: 'operator',
      sessionId: 'session-42',
      note: 'Escalated for the release gate.',
      before: { priority: 'medium', dueDate: null },
      after: { priority: 'critical', dueDate: '2026-07-20' },
    };
    const failure: KanbanEvent = {
      id: 'failed',
      boardId: 'board-1',
      taskId: task.id,
      type: 'task.assignment.failed',
      ts: '2026-07-16T08:12:00.000Z',
      actor: 'reviewer-1',
      sessionId: 'session-42',
      subagentId: 'subagent-7',
      runTaskId: 'run-99',
      note: 'Primary route timed out.',
      after: {
        status: 'failed',
        modelRouting: 'fallback_profile',
        provider: 'openai',
        model: 'gpt-5.4',
        fallbackProfile: 'resilient',
        fallbackModels: ['anthropic/claude-opus'],
        attempt: 2,
        maxAttempts: 4,
      },
    };

    expect(eventFieldChanges(update)).toEqual([
      { field: 'priority', before: 'medium', after: 'critical' },
      { field: 'dueDate', before: null, after: '2026-07-20' },
    ]);
    expect(activityCategory(failure)).toBe('failures');

    render(
      <TaskActivityTimeline
        task={task}
        events={[...events, update, failure]}
        sessionId="session-42"
      />,
    );

    expect(screen.getByText('Task contract updated')).toBeTruthy();
    expect(screen.getByText('Escalated for the release gate.')).toBeTruthy();
    expect(screen.getByText('model:openai/gpt-5.4')).toBeTruthy();
    expect(screen.getByText('fallback-1:anthropic/claude-opus')).toBeTruthy();
    expect(screen.getByText('attempt:2/4')).toBeTruthy();
    expect(screen.getAllByText('Full event payload').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'failures 1' }));
    expect(screen.getByText('Agent run failed')).toBeTruthy();
    expect(screen.queryByText('Task contract updated')).toBeNull();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search task activity' }), {
      target: { value: 'claude-opus' },
    });
    expect(screen.getByText('Agent run failed')).toBeTruthy();
  });

  it('builds portable full and filtered audit evidence and exposes export controls', () => {
    const activity = buildTaskActivity(task, events, 'session-42');
    const exported = buildTaskActivityExport(
      task,
      activity.slice(0, 1),
      'filtered',
      '2026-07-16T09:00:00.000Z',
    );

    expect(exported).toMatchObject({
      format: 'wrongstack-kanban-task-activity',
      version: 1,
      exportedAt: '2026-07-16T09:00:00.000Z',
      scope: 'filtered',
      task: { id: task.id, title: task.title },
    });
    expect(exported.events).toHaveLength(1);

    render(<TaskActivityTimeline task={task} events={events} sessionId="session-42" />);
    expect(screen.getByRole('button', { name: 'Copy visible task activity JSON' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download full task activity JSON' })).toBeTruthy();
  });

  it('classifies and renders structured manual decisions and failed outcomes', () => {
    const decision: KanbanEvent = {
      id: 'decision',
      boardId: 'board-1',
      taskId: task.id,
      type: 'task.activity.decision',
      ts: '2026-07-16T08:13:00.000Z',
      actor: 'release-lead',
      sessionId: 'session-42',
      note: 'Do not ship this attempt.',
      after: {
        kind: 'decision',
        outcome: 'failed',
        details: 'Acceptance evidence is incomplete.',
      },
    };

    expect(activityCategory(decision)).toBe('failures');
    render(<TaskActivityTimeline task={task} events={[...events, decision]} />);

    expect(screen.getByText('Recorded Decision')).toBeTruthy();
    expect(screen.getByText('Do not ship this attempt.')).toBeTruthy();
    expect(screen.getByText('failed · Acceptance evidence is incomplete.')).toBeTruthy();
  });

  it('keeps the complete retained event range instead of truncating audit/export data', () => {
    const manyEvents: KanbanEvent[] = Array.from({ length: 300 }, (_, index) => ({
      id: `event-${index}`,
      boardId: 'board-1',
      taskId: task.id,
      type: 'task.activity.observation',
      ts: new Date(Date.parse('2026-07-16T09:00:00.000Z') + index * 1_000).toISOString(),
      actor: 'audit-agent',
      sessionId: 'session-42',
      note: `Observation ${index}`,
      after: { kind: 'observation', outcome: 'unknown' },
    }));

    const activity = buildTaskActivity(task, manyEvents, 'session-42');
    expect(activity).toHaveLength(304);
    expect(activity[0]?.id).toBe('event-299');
  });
});
