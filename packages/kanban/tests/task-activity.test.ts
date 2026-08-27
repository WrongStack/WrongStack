import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addCheckToTask,
  addGoalMetricToTask,
  addNoteToTask,
  addTask,
  assignTask,
  createBoard,
  getTask,
  listTaskActivity,
  recordTaskActivity,
  recordTaskFileActivity,
  updateCheckOnTask,
  updateGoalMetricOnTask,
  updateTask,
  updateTaskAssignment,
} from './helpers/session-manager.js';

const roots: string[] = [];

async function projectRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-activity-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('task activity', () => {
  it('filters a board event stream by task and preserves session and agent identity', async () => {
    const root = await projectRoot();
    const board = await createBoard(root, { title: 'Activity board' });
    const first = await addTask(
      root,
      board.id,
      { title: 'Tracked task', columnId: 'backlog' },
      { actor: 'webui', sessionId: 'session-42' },
    );
    await addTask(root, board.id, { title: 'Other task', columnId: 'backlog' });

    await assignTask(
      root,
      board.id,
      first!.task.id,
      { agentId: 'reviewer-1', role: 'reviewer', status: 'queued' },
      { sessionId: 'session-42' },
    );
    await updateTaskAssignment(
      root,
      board.id,
      first!.task.id,
      { status: 'running', subagentId: 'subagent-7' },
      { sessionId: 'session-42' },
    );
    await addNoteToTask(
      root,
      board.id,
      first!.task.id,
      { author: 'operator', content: 'Verified the public API surface.' },
      { actor: 'operator', sessionId: 'session-42' },
    );

    const activity = await listTaskActivity(root, board.id, first!.task.id);

    expect(activity.map((event) => event.type)).toEqual([
      'task.note.added',
      'task.assignment.running',
      'task.assigned',
      'task.created',
    ]);
    expect(activity.every((event) => event.taskId === first!.task.id)).toBe(true);
    expect(activity.every((event) => event.sessionId === 'session-42')).toBe(true);
    expect(activity.find((event) => event.type === 'task.assigned')?.actor).toBe('reviewer-1');
    expect(activity.find((event) => event.type === 'task.note.added')?.actor).toBe('operator');
    expect(activity.find((event) => event.type === 'task.assignment.running')?.subagentId).toBe(
      'subagent-7',
    );
  });

  it('returns newest events first and enforces the requested limit', async () => {
    const root = await projectRoot();
    const board = await createBoard(root, { title: 'Limited activity' });
    const added = await addTask(root, board.id, { title: 'Task', columnId: 'backlog' });
    await addNoteToTask(root, board.id, added!.task.id, { author: 'one', content: 'First' });
    await addNoteToTask(root, board.id, added!.task.id, { author: 'two', content: 'Second' });

    const activity = await listTaskActivity(root, board.id, added!.task.id, { limit: 2 });

    expect(activity).toHaveLength(2);
    expect(activity.map((event) => event.note)).toEqual(['Second', 'First']);
  });

  it('records a human reason and only the task fields that actually changed', async () => {
    const root = await projectRoot();
    const board = await createBoard(root, { title: 'Change audit' });
    const added = await addTask(root, board.id, {
      title: 'Release the task ledger',
      columnId: 'backlog',
      priority: 'medium',
    });

    await updateTask(
      root,
      board.id,
      added!.task.id,
      { priority: 'critical', dueDate: '2026-07-20' },
      {
        actor: 'operator-1',
        sessionId: 'session-audit',
        note: 'Launch is blocked on this audit trail.',
      },
    );

    const activity = await listTaskActivity(root, board.id, added!.task.id);
    const updated = activity.find((event) => event.type === 'task.updated');

    expect(updated).toMatchObject({
      actor: 'operator-1',
      sessionId: 'session-audit',
      note: 'Launch is blocked on this audit trail.',
      before: { priority: 'medium', dueDate: null },
      after: { priority: 'critical', dueDate: '2026-07-20' },
    });
    expect(Object.keys(updated?.after as Record<string, unknown>).sort()).toEqual([
      'dueDate',
      'priority',
    ]);
  });

  it('attributes acceptance-check and goal-metric changes with complete before/after evidence', async () => {
    const root = await projectRoot();
    const board = await createBoard(root, { title: 'Verification audit' });
    const added = await addTask(root, board.id, {
      title: 'Verify the release',
      columnId: 'review',
    });
    const context = {
      actor: 'release-operator',
      sessionId: 'session-verification',
      note: 'Release evidence was reviewed.',
    };

    const withCheck = await addCheckToTask(
      root,
      board.id,
      added!.task.id,
      { description: 'Regression suite passes', type: 'test' },
      context,
    );
    const checkId = withCheck!.tasks.find((task) => task.id === added!.task.id)!
      .successCriteria![0]!.id;
    await updateCheckOnTask(
      root,
      board.id,
      added!.task.id,
      checkId,
      { status: 'passed', checkedBy: 'release-operator', notes: '192 tests passed.' },
      context,
    );

    const withMetric = await addGoalMetricToTask(
      root,
      board.id,
      added!.task.id,
      { name: 'Failed checks', target: 0, current: 1 },
      context,
    );
    const metricId = withMetric!.tasks.find((task) => task.id === added!.task.id)!.goalMetrics![0]!
      .id;
    await updateGoalMetricOnTask(
      root,
      board.id,
      added!.task.id,
      metricId,
      { current: 0, status: 'met', notes: 'All checks are green.' },
      context,
    );

    const activity = await listTaskActivity(root, board.id, added!.task.id);
    const checkUpdate = activity.find((event) => event.type === 'task.check.updated');
    const metricUpdate = activity.find((event) => event.type === 'task.metric.updated');

    expect(checkUpdate).toMatchObject({
      actor: 'release-operator',
      sessionId: 'session-verification',
      note: 'Release evidence was reviewed.',
      before: { status: 'pending' },
      after: {
        status: 'passed',
        checkedBy: 'release-operator',
        notes: '192 tests passed.',
      },
    });
    expect(metricUpdate).toMatchObject({
      actor: 'release-operator',
      sessionId: 'session-verification',
      before: { current: 1, status: 'pending' },
      after: { current: 0, status: 'met', notes: 'All checks are green.' },
    });
  });

  it('records structured manual decisions, attempts, blockers, and outcomes', async () => {
    const root = await projectRoot();
    const board = await createBoard(root, { title: 'Decision audit' });
    const added = await addTask(root, board.id, { title: 'Choose a release route' });

    await recordTaskActivity(
      root,
      board.id,
      added!.task.id,
      {
        kind: 'decision',
        summary: 'Use the resilient fallback profile.',
        outcome: 'succeeded',
        details: 'Primary remains openai/gpt-5.4; Anthropic is the first fallback.',
      },
      { actor: 'release-lead', sessionId: 'session-decision' },
    );

    const activity = await listTaskActivity(root, board.id, added!.task.id);
    expect(activity[0]).toMatchObject({
      type: 'task.activity.decision',
      actor: 'release-lead',
      sessionId: 'session-decision',
      note: 'Use the resilient fallback profile.',
      after: {
        kind: 'decision',
        outcome: 'succeeded',
        details: 'Primary remains openai/gpt-5.4; Anthropic is the first fallback.',
      },
    });
  });

  it('records task-scoped file reads and writes without mutating the card', async () => {
    const root = await projectRoot();
    const board = await createBoard(root, { title: 'File audit' });
    const added = await addTask(root, board.id, { title: 'Trace implementation files' });
    const updatedAt = added!.task.updatedAt;

    const recorded = await recordTaskFileActivity(root, board.id, added!.task.id, {
      operation: 'update',
      filePath: 'src/app.ts',
      sessionId: 'session-files',
      agentId: 'agent-files',
      agentName: 'Ada',
      provider: 'openai',
      model: 'gpt-5',
      toolName: 'apply_patch',
      toolUseId: 'tool-files-1',
      durationMs: 25,
      lines: 12,
    });

    expect(recorded).toBe(true);
    const activity = await listTaskActivity(root, board.id, added!.task.id);
    expect(activity[0]).toMatchObject({
      type: 'task.file.update',
      actor: 'Ada',
      sessionId: 'session-files',
      correlationId: 'tool-files-1',
      note: 'update src/app.ts',
      after: {
        operation: 'update',
        filePath: 'src/app.ts',
        toolName: 'apply_patch',
        provider: 'openai',
        model: 'gpt-5',
        durationMs: 25,
        lines: 12,
      },
    });
    const current = await getTask(root, board.id, added!.task.id);
    expect(current?.updatedAt).toBe(updatedAt);
  });
});
