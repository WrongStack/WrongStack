import { completionPercent } from '@wrongstack/contracts/types/task-graph';
import { describe, expect, it } from 'vitest';
import {
  computeTaskItemProgress,
  formatTaskList,
  formatTaskProgress,
  type TaskItem,
} from '../../src/utils/task-format.js';

const mk = (over: Partial<TaskItem> & { id: string; status: TaskItem['status'] }): TaskItem => ({
  title: `task ${over.id}`,
  type: 'feature',
  priority: 'medium',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  ...over,
});

describe('completion percentage', () => {
  it('reads 100% only when every task is completed', () => {
    const tasks: TaskItem[] = Array.from({ length: 200 }, (_, i) =>
      mk({ id: String(i), status: i === 0 ? 'pending' : 'completed' }),
    );
    expect(computeTaskItemProgress(tasks).percentComplete).toBe(99);
    expect(completionPercent(200, 200)).toBe(100);
    expect(completionPercent(0, 0)).toBe(0);
    expect(completionPercent(1, 3)).toBe(33);
  });
});

describe('computeTaskItemProgress', () => {
  it('counts every status bucket and sums estimate hours', () => {
    const tasks: TaskItem[] = [
      mk({ id: '1', status: 'completed', estimateHours: 2 }),
      mk({ id: '2', status: 'pending' }),
      mk({ id: '3', status: 'in_progress', estimateHours: 3 }),
      mk({ id: '4', status: 'blocked' }),
      mk({ id: '5', status: 'failed' }),
      mk({ id: '6', status: 'review' }),
    ];
    const p = computeTaskItemProgress(tasks);
    expect(p).toMatchObject({
      total: 6,
      completed: 1,
      pending: 1,
      inProgress: 1,
      blocked: 1,
      failed: 1,
      review: 1,
      estimatedHours: 5,
      actualHours: 0,
      percentComplete: 17, // round(1/6*100)
    });
  });

  it('reports 0% for an empty list', () => {
    expect(computeTaskItemProgress([])).toMatchObject({ total: 0, percentComplete: 0 });
  });
});

describe('formatTaskProgress', () => {
  it('returns a placeholder for no tasks', () => {
    expect(formatTaskProgress([])).toBe('No tasks.');
  });

  it('renders a progress bar with the estimate line when hours are present', () => {
    const out = formatTaskProgress([
      mk({ id: '1', status: 'completed', estimateHours: 4 }),
      mk({ id: '2', status: 'pending' }),
    ]);
    expect(out).toContain('Tasks');
    expect(out).toMatch(/50%/);
    expect(out).toContain('est. 4h');
  });

  it('omits the estimate line when there are no estimate hours', () => {
    const out = formatTaskProgress([mk({ id: '1', status: 'completed' })]);
    expect(out).not.toContain('est.');
  });
});

describe('formatTaskList', () => {
  it('returns a placeholder for no tasks', () => {
    expect(formatTaskList([])).toBe('No tasks.');
  });

  it('groups by status in order and renders deps/assignee/hours decorations', () => {
    const out = formatTaskList([
      mk({
        id: 'aaaaaaaa11',
        status: 'in_progress',
        priority: 'critical',
        type: 'bugfix',
        dependsOn: ['bbbbbbbb22', 'cccccccc33'],
        assignee: 'neo',
        estimateHours: 8,
      }),
      mk({ id: 'd2', status: 'completed', type: 'docs', priority: 'low' }),
    ]);
    expect(out).toContain('Tasks (2 total):');
    expect(out).toContain('IN_PROGRESS (1)');
    expect(out).toContain('COMPLETED (1)');
    expect(out).toContain('@neo');
    expect(out).toContain('8h');
    expect(out).toContain('aaaaaaaa'); // dep ids sliced to 8 chars
  });

  it('renders a task with no optional decorations', () => {
    const out = formatTaskList([mk({ id: '1', status: 'pending' })]);
    expect(out).toContain('PENDING (1)');
    expect(out).not.toContain('@');
  });

  it('strips terminal controls from model-authored title, assignee and deps', () => {
    // The plain REPL writes this text straight to the TTY: OSC 52 would write
    // the clipboard and ESC[2J clear the screen.
    const out = formatTaskList([
      mk({
        id: '1',
        status: 'pending',
        title: 'ok\x1b]52;c;cm0=\x07\x1b[2J',
        assignee: 'a\x1b[8m',
        dependsOn: ['\x1bc12345678'],
      }),
    ]);
    expect(out.replace(/\x1b\[[0-9;]*m/g, '')).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    expect(out).not.toContain('\x1b[8m');
    expect(out).toContain('ok');
  });
});
