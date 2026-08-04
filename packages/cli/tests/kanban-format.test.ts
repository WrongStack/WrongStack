/**
 * Focused coverage for kanban-format.ts — the pure formatting surface used by
 * /kanban slash commands. The module only imports `color` from core and two
 * runtime helpers from @wrongstack/kanban, so a targeted mock keeps these
 * tests hermetic (no kanban daemon or dist dependency).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  areDependenciesMet: vi.fn(() => true),
  findBlockedTasks: vi.fn(() => []),
}));

vi.mock('@wrongstack/kanban', () => ({
  areDependenciesMet: h.areDependenciesMet,
  findBlockedTasks: h.findBlockedTasks,
}));

import {
  fmtAge,
  formatBoardDetail,
  formatBoardList,
  formatDependencyChain,
  formatKanbanSnapshot,
  formatReadyTasks,
  formatTaskChain,
  formatTaskDetail,
} from '../src/slash-commands/kanban-format.js';

const now = Date.now();
const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();

function baseTask(over: Record<string, unknown> = {}): never {
  return {
    id: 'task-1',
    title: 'Write tests',
    description: 'Cover the formatter',
    status: 'in_progress',
    priority: 'high',
    columnId: 'col-1',
    createdAt: iso(3600_000 * 5),
    updatedAt: iso(60_000 * 30),
    order: 1,
    ...over,
  } as never;
}

function baseBoard(over: Record<string, unknown> = {}): never {
  return {
    id: 'board-1234567890',
    title: 'Sprint',
    description: 'Current sprint',
    createdAt: iso(3600_000 * 24 * 2),
    updatedAt: iso(3600_000),
    tags: ['sprint', 'q3'],
    columns: [{ id: 'col-1', title: 'In Progress', wipLimit: 2 }],
    tasks: [
      baseTask({ columnId: 'col-1' }),
      baseTask({ id: 'task-2', title: 'Blocked task', status: 'blocked', priority: 'critical' }),
      baseTask({ id: 'task-3', title: 'Done task', status: 'completed', priority: 'low' }),
    ],
    ...over,
  } as never;
}

beforeEach(() => {
  h.areDependenciesMet.mockReturnValue(true);
  h.findBlockedTasks.mockReturnValue([]);
  vi.setSystemTime(now);
});

describe('kanban-format — pure formatting coverage', () => {
  it('fmtAge buckets ages correctly', () => {
    expect(fmtAge(iso(10_000))).toBe('just now');
    expect(fmtAge(iso(5 * 60_000))).toBe('5m ago');
    expect(fmtAge(iso(3 * 3600_000))).toBe('3h ago');
    expect(fmtAge(iso(2 * 24 * 3600_000))).toBe('2d ago');
  });

  it('formatBoardList handles empty and populated boards', () => {
    expect(formatBoardList([])).toContain('No kanban boards yet');
    const out = formatBoardList([
      {
        id: 'board-1234567890',
        title: 'Sprint',
        columnCount: 3,
        taskCount: 4,
        completedTaskCount: 2,
      } as never,
      {
        id: 'board-abcdef1234',
        title: 'Empty board',
        columnCount: 1,
        taskCount: 0,
        completedTaskCount: 0,
      } as never,
    ]);
    expect(out).toContain('Kanban Boards (2)');
    expect(out).toContain('50% done');
    expect(out).toContain('empty');
  });

  it('formatBoardDetail renders columns, WIP, tags, and task markers', () => {
    const out = formatBoardDetail(baseBoard());
    expect(out).toContain('Sprint');
    expect(out).toContain('In Progress');
    expect(out).toContain('[1/2]'); // WIP
    expect(out).toContain('sprint');
    expect(out).toContain('🔄 Write tests');
    expect(out).toContain('🚫 Blocked task');
    expect(out).toContain('✅ Done task');
  });

  it('formatBoardDetail renders empty columns and optional fields', () => {
    const out = formatBoardDetail(
      baseBoard({
        description: undefined,
        tags: [],
        columns: [{ id: 'col-empty', title: 'Empty', wipLimit: 0 }],
        tasks: [],
      }),
    );
    expect(out).toContain('— empty —');
  });

  it('formatTaskDetail renders the full task surface', () => {
    const task = baseTask({
      assignedAgent: 'agent-a',
      assignee: 'user-x',
      chain: { chainId: 'ch-1', order: 0, previousTaskId: undefined, nextTaskId: 'task-2' },
      parentTaskId: 'parent-1',
      childTaskIds: ['child-1'],
      mergedIntoTaskId: 'merged-into',
      mergedFromTaskIds: ['m1', 'm2'],
      dependsOn: ['task-2'],
      successCriteria: [
        { description: 'tests pass', status: 'passed', checkedBy: 'agent-a', checkedAt: iso(60_000) },
        { description: 'no regressions', status: 'failed' },
        { description: 'skipped one', status: 'skipped' },
        { description: 'pending one', status: 'pending' },
      ],
      goalMetrics: [
        { name: 'coverage', current: 90, target: 95, unit: '%', status: 'in_progress', notes: 'nearly' },
        { name: 'without target', current: 1, target: undefined, unit: undefined, status: 'pending' },
      ],
      estimatedHours: 4,
      actualHours: 3,
      links: [{ title: 'PR', url: 'https://example.test/pr', type: 'pr' }],
      notes: [{ author: 'agent-a', content: 'remember', createdAt: iso(60_000) }],
    });
    h.areDependenciesMet.mockReturnValue(false);
    const out = formatTaskDetail(baseBoard(), task);
    expect(out).toContain('Write tests');
    expect(out).toContain('IN_PROGRESS');
    expect(out).toContain('Depends on');
    expect(out).toContain('No');
    expect(out).toContain('✅ tests pass');
    expect(out).toContain('❌ no regressions');
    expect(out).toContain('⏭️ skipped one');
    expect(out).toContain('⬜ pending one');
    expect(out).toContain('coverage');
    expect(out).toContain('Est.');
    expect(out).toContain('PR');
    expect(out).toContain('remember');
    expect(out).toContain('ch-1 #1');
    expect(out).toContain('Merged from');
  });

  it('formatTaskDetail renders blocked-after tasks and missing columns', () => {
    h.findBlockedTasks.mockReturnValue([{ title: 'dep-task' } as never]);
    const task = baseTask({ columnId: 'missing-col', successCriteria: [] });
    const out = formatTaskDetail(baseBoard(), task);
    expect(out).toContain('missing-col');
    expect(out).toContain('Blocks');
    expect(out).toContain('dep-task');
  });

  it('formatDependencyChain renders missing tasks, icons, and nested deps', () => {
    expect(formatDependencyChain(baseBoard(), 'nope')).toContain('Task not found');
    const out = formatDependencyChain(
      baseBoard({
        tasks: [
          baseTask({ id: 'root', status: 'completed' }),
          baseTask({ id: 'dep-a', title: 'Dep A', dependsOn: ['dep-b'], status: 'blocked' }),
          baseTask({ id: 'dep-b', title: 'Dep B', status: 'in_progress' }),
        ],
      }),
      'root',
    );
    expect(out).toContain('✅ root');
    expect(out).toContain('🚫 Dep A');
    expect(out).toContain('🔄 Dep B');
  });

  it('formatReadyTasks renders routing and chain info', () => {
    expect(formatReadyTasks([])).toContain('No ready kanban tasks');
    const out = formatReadyTasks([
      {
        board: { id: 'board-1234567890', title: 'S', taskCount: 1, completedTaskCount: 0 } as never,
        task: baseTask({ assignment: { provider: 'anthropic', model: 'claude' } }),
      },
      {
        board: { id: 'board-abcdef1234', title: 'S2', taskCount: 1, completedTaskCount: 0 } as never,
        task: baseTask({ chain: { chainId: 'ch', order: 2 } }),
      },
    ]);
    expect(out).toContain('Ready Tasks (2)');
    expect(out).toContain('[anthropic/claude]');
    expect(out).toContain('#3');
  });

  it('formatKanbanSnapshot renders counts and next-ready list', () => {
    const empty = formatKanbanSnapshot({
      boards: [], ready: [], queued: [], running: [], blocked: [], review: [], failed: [], completed: [],
    } as never);
    expect(empty).toContain('Boards');
    const withReady = formatKanbanSnapshot({
      boards: [],
      ready: [
        {
          board: { id: 'board-1234567890', title: 'S', taskCount: 1, completedTaskCount: 0 } as never,
          task: baseTask(),
        },
      ],
      queued: [], running: [], blocked: [], review: [], failed: [], completed: [],
    } as never);
    expect(withReady).toContain('Next Ready');
    expect(withReady).toContain('board-12:task-1');
  });

  it('formatTaskChain renders empty and populated chains', () => {
    expect(formatTaskChain([])).toContain('No tasks in chain');
    const out = formatTaskChain([
      baseTask({ id: 'c1', chain: { chainId: 'ch-1', order: 0 } }),
      baseTask({ id: 'c2', dependsOn: ['c1'], status: 'completed' }),
    ]);
    expect(out).toContain('Task Chain (ch-1)');
    expect(out).toContain('1. Write tests');
    expect(out).toContain('dep');
  });
});
