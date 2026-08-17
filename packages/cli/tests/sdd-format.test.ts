import type { Specification, TaskGraph, TaskNode, TaskProgress } from '@wrongstack/core/types';
import type { CriticalPathAnalysis, SpecIndexEntry } from '@wrongstack/sdd';
import { describe, expect, it } from 'vitest';
import {
  formatBlockedTasks,
  formatCriticalPathAnalysis,
  formatCurrentSpec,
  formatGraphListFallback,
  formatNextTaskView,
  formatSddStatusView,
  formatSpecList,
  formatTaskListView,
  sortTasksForSddDisplay,
  taskStatusIcon,
} from '../src/slash-commands/sdd-format.js';

const NOW = 1_700_000_000_000;

function node(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 'task-1',
    title: 'Task',
    description: '',
    type: 'feature',
    priority: 'medium',
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function progress(overrides: Partial<TaskProgress> = {}): TaskProgress {
  return {
    total: 1,
    pending: 1,
    inProgress: 0,
    blocked: 0,
    failed: 0,
    review: 0,
    completed: 0,
    percentComplete: 0,
    estimatedHours: 0,
    actualHours: 0,
    ...overrides,
  };
}

const formatElapsed = (ms: number) => `${Math.round(ms / 1000)}s`;
const renderProgress = (p: TaskProgress) => `progress ${p.completed}/${p.total}`;

describe('taskStatusIcon', () => {
  it('maps every known status to its icon', () => {
    expect(taskStatusIcon('completed')).toBe('✅');
    expect(taskStatusIcon('in_progress')).toBe('🔄');
    expect(taskStatusIcon('failed')).toBe('❌');
    expect(taskStatusIcon('blocked')).toBe('🚫');
    expect(taskStatusIcon('review')).toBe('👁');
    expect(taskStatusIcon('pending')).toBe('⏳');
  });

  it('falls back to the pending icon for an unrecognized status', () => {
    expect(taskStatusIcon('unknown' as TaskNode['status'])).toBe('⏳');
  });
});

describe('sortTasksForSddDisplay', () => {
  it('sorts by activity order: in_progress first, completed last', () => {
    const sorted = sortTasksForSddDisplay([
      node({ id: 'c', status: 'completed' }),
      node({ id: 'p', status: 'pending' }),
      node({ id: 'i', status: 'in_progress' }),
    ]);
    expect(sorted.map((n) => n.id)).toEqual(['i', 'p', 'c']);
  });

  it('places every known status in the documented order', () => {
    const ordered = ['in_progress', 'pending', 'review', 'blocked', 'failed', 'completed'];
    const shuffled = [...ordered].reverse();
    const sorted = sortTasksForSddDisplay(
      shuffled.map((status, i) => node({ id: `${status}-${i}`, status: status as TaskNode['status'] })),
    );
    expect(sorted.map((n) => n.status)).toEqual(ordered);
  });

  it('sorts unknown statuses after all known ones', () => {
    const sorted = sortTasksForSddDisplay([
      node({ id: 'mystery', status: 'weird' as TaskNode['status'] }),
      node({ id: 'done', status: 'completed' }),
    ]);
    expect(sorted.map((n) => n.id)).toEqual(['done', 'mystery']);
  });

  it('does not mutate the input array', () => {
    const input = [node({ status: 'completed' }), node({ status: 'in_progress' })];
    const snapshot = input.map((n) => n.status);
    sortTasksForSddDisplay(input);
    expect(input.map((n) => n.status)).toEqual(snapshot);
  });

  it('returns a new array for an empty input', () => {
    expect(sortTasksForSddDisplay([])).toEqual([]);
  });
});

describe('formatSpecList', () => {
  function entry(overrides: Partial<SpecIndexEntry> = {}): SpecIndexEntry {
    return {
      id: 'spec-0123456789abcdef',
      title: 'My Spec',
      version: '1.0.0',
      status: 'draft',
      updatedAt: NOW,
      filePath: '/specs/spec.json',
      ...overrides,
    };
  }

  it('renders draft and approved statuses with distinct icons', () => {
    const out = formatSpecList([entry(), entry({ id: 'b'.repeat(16), status: 'approved' })]);
    expect(out.split('\n')[1]).toContain('📝 My Spec');
    expect(out.split('\n')[2]).toContain('✅');
  });

  it('uses the generic icon for statuses other than draft/approved', () => {
    const out = formatSpecList([entry({ status: 'implemented' as SpecIndexEntry['status'] })]);
    expect(out).toContain('📋');
  });

  it('truncates the id to its first 8 characters followed by ellipsis', () => {
    const out = formatSpecList([entry({ id: '0123456789ABCDEFGH' })]);
    expect(out).toContain('— 01234567...');
  });

  it('numbers entries starting at 1', () => {
    const out = formatSpecList([entry(), entry({ id: 'bbbbbbbbbbbb' })]);
    expect(out.split('\n')[1]?.startsWith('1. ')).toBe(true);
    expect(out.split('\n')[2]?.startsWith('2. ')).toBe(true);
  });

  it('renders an empty list with only the header', () => {
    expect(formatSpecList([])).toBe('Saved Specs:\n');
  });
});

describe('formatCurrentSpec', () => {
  function spec(overrides: Partial<Specification> = {}): Specification {
    return {
      id: 'spec-1',
      title: 'Title',
      version: '2.0.0',
      status: 'approved',
      overview: 'An overview.',
      sections: [],
      requirements: [],
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it('renders header, overview, and skips requirements when none exist', () => {
    const out = formatCurrentSpec(spec());
    expect(out).toContain('═══ Current Spec ═══');
    expect(out).toContain('Title: Title');
    expect(out).toContain('Version: 2.0.0');
    expect(out).toContain('Status: approved');
    expect(out).toContain('## Overview');
    expect(out).toContain('An overview.');
    expect(out).not.toContain('## Requirements');
  });

  it('lists requirements with priority and joined acceptance criteria', () => {
    const out = formatCurrentSpec(
      spec({
        requirements: [
          {
            id: 'r1',
            type: 'functional' as const,
            description: 'Must work',
            priority: 'critical',
            acceptanceCriteria: ['fast', 'correct'],
          },
        ],
      }),
    );
    expect(out).toContain('## Requirements (1)');
    expect(out).toContain('[critical] Must work → fast, correct');
  });

  it('omits the acceptance criteria suffix when the list is empty', () => {
    const out = formatCurrentSpec(
      spec({
        requirements: [
          { id: 'r1', type: 'functional' as const, description: 'No criteria', priority: 'low', acceptanceCriteria: [] },
        ],
      }),
    );
    expect(out).toContain('[low] No criteria');
    expect(out).not.toContain('→');
  });
});

describe('formatTaskListView', () => {
  it('renders a known phase label with progress and command hints', () => {
    const out = formatTaskListView(
      [node({ title: 'Write tests', priority: 'critical', description: 'Cover everything' })],
      progress({ total: 1 }),
      'implementation',
      renderProgress,
      formatElapsed,
    );
    expect(out).toContain('🏗️ Implementation');
    expect(out).toContain('progress 0/1');
    expect(out).toContain('Write tests');
    expect(out).toContain('↳ Cover everything');
    expect(out).toContain('/sdd done <N>');
  });

  it('falls back to the raw phase string when the phase is unknown', () => {
    const out = formatTaskListView([], progress(), 'mystery' as never, renderProgress, formatElapsed);
    expect(out).toContain('mystery');
  });

  it('shows elapsed time only for in_progress tasks with startedAt', () => {
    const started = Date.now() - 60_000;
    const out = formatTaskListView(
      [
        node({ status: 'in_progress', startedAt: started }),
        node({ id: 't2', status: 'in_progress' }),
        node({ id: 't3', status: 'pending', startedAt: started }),
      ],
      progress({ total: 3, inProgress: 2, pending: 1 }),
      'executing',
      renderProgress,
      formatElapsed,
    );
    expect(out).toContain('(60s)');
    expect(out.match(/\(\d+s\)/g)).toHaveLength(1);
  });

  it('truncates long titles at 35 characters plus an ellipsis', () => {
    const longTitle = 'T'.repeat(50);
    const out = formatTaskListView(
      [node({ title: longTitle })],
      progress(),
      'done',
      renderProgress,
      formatElapsed,
    );
    expect(out).toContain(`${'T'.repeat(35)}…`);
    expect(out).not.toContain(`${'T'.repeat(36)}`);
  });

  it('truncates long first description lines at 41 characters plus an ellipsis', () => {
    const longDesc = 'D'.repeat(60);
    const out = formatTaskListView(
      [node({ description: longDesc })],
      progress(),
      'spec_review',
      renderProgress,
      formatElapsed,
    );
    expect(out).toContain(`↳ ${'D'.repeat(41)}…`);
  });

  it('uses only the first line of a multi-line description', () => {
    const out = formatTaskListView(
      [node({ description: 'first line\nsecond line' })],
      progress(),
      'questioning',
      renderProgress,
      formatElapsed,
    );
    expect(out).toContain('↳ first line');
    expect(out).not.toContain('second line');
  });

  it('hides descriptions of completed tasks', () => {
    const out = formatTaskListView(
      [node({ status: 'completed', description: 'already done' })],
      progress({ completed: 1, pending: 0 }),
      'task_review',
      renderProgress,
      formatElapsed,
    );
    expect(out).not.toContain('already done');
  });

  it('pads numbers and truncates priority to 4 characters', () => {
    const out = formatTaskListView(
      [node({ priority: 'critical', title: 'X' })],
      progress(),
      'implementation',
      renderProgress,
      formatElapsed,
    );
    expect(out).toContain('    1  ⏳');
    expect(out).toContain('crit');
    expect(out).not.toContain('criti');
  });

  it('skips holes in the node array without shifting numbering of later entries', () => {
    const sparse = [node({ title: 'first' }), undefined as unknown as TaskNode, node({ id: 't2', title: 'third' })];
    const out = formatTaskListView(sparse, progress({ total: 2 }), 'implementation', renderProgress, formatElapsed);
    expect(out).toContain('first');
    expect(out).toContain('third');
    expect(out).not.toContain('undefined');
  });
});

describe('formatBlockedTasks', () => {
  it('lists blockers with resolved titles', () => {
    const tracker = {
      getBlockers: (id: string) => (id === 'b1' ? ['dep-1', 'dep-2'] : []),
      getNode: (id: string) =>
        id === 'dep-1'
          ? node({ id, title: 'Dependency One' })
          : id === 'dep-2'
            ? node({ id, title: 'Dependency Two' })
            : undefined,
    };
    const out = formatBlockedTasks([node({ id: 'b1', title: 'Blocked task' })], tracker);
    expect(out).toContain('🚫 1 task(s) blocked');
    expect(out).toContain('1. Blocked task (blocked by: Dependency One, Dependency Two)');
  });

  it('renders unknown blocker nodes as a question mark', () => {
    const tracker = {
      getBlockers: () => ['ghost'],
      getNode: () => undefined,
    };
    const out = formatBlockedTasks([node({ title: 'B' })], tracker);
    expect(out).toContain('(blocked by: ?)');
  });

  it('handles an empty blocked list', () => {
    const out = formatBlockedTasks([], { getBlockers: () => [], getNode: () => undefined });
    expect(out).toContain('🚫 0 task(s) blocked');
  });
});

describe('formatNextTaskView', () => {
  const trackerFor = (nodes: TaskNode[], blockersOf: Record<string, string[]>) => ({
    getBlockers: (id: string) => blockersOf[id] ?? [],
    getNode: (id: string) => nodes.find((n) => n.id === id),
  });

  it('renders task metadata and progress without blockers', () => {
    const out = formatNextTaskView(
      node({ id: 'n1', title: 'Next up', priority: 'high', estimateHours: 3, tags: ['a', 'b'] }),
      progress({ total: 5, completed: 2, percentComplete: 40 }),
      trackerFor([], {}),
      formatElapsed,
    );
    expect(out).toContain('🔄 Next up');
    expect(out).toContain('Priority: high  |  Est: 3h  |  Tags: a, b');
    expect(out).toContain('Progress: 2/5 (40%)');
    expect(out).not.toContain('Blocked by:');
  });

  it('falls back to "none" when tags are missing or empty', () => {
    const noTags = formatNextTaskView(node({ id: 'n1' }), progress(), trackerFor([], {}), formatElapsed);
    const emptyTags = formatNextTaskView(
      node({ id: 'n1', tags: [] }),
      progress(),
      trackerFor([], {}),
      formatElapsed,
    );
    expect(noTags).toContain('Tags: none');
    expect(emptyTags).toContain('Tags: none');
  });

  it('shows only the first description line', () => {
    const out = formatNextTaskView(
      node({ description: 'line one\nline two' }),
      progress(),
      trackerFor([], {}),
      formatElapsed,
    );
    expect(out).toContain('↳ line one');
    expect(out).not.toContain('line two');
  });

  it('shows elapsed time when startedAt is set', () => {
    const out = formatNextTaskView(
      node({ startedAt: Date.now() - 30_000 }),
      progress(),
      trackerFor([], {}),
      formatElapsed,
    );
    expect(out).toContain('⏱ 30s');
  });

  it('lists only incomplete blockers', () => {
    const depDone = node({ id: 'd1', title: 'Done dep', status: 'completed' });
    const depOpen = node({ id: 'd2', title: 'Open dep' });
    const out = formatNextTaskView(
      node({ id: 'n1' }),
      progress(),
      trackerFor([depDone, depOpen], { n1: ['d1', 'd2'] }),
      formatElapsed,
    );
    expect(out).toContain('Blocked by: Open dep');
    expect(out).not.toContain('Done dep');
  });
});

describe('formatSddStatusView', () => {
  const baseSession = {
    id: 'sessions/abc/sessions/long-session-id-123456',
    title: 'My Session',
    phase: 'questioning' as const,
    questionCount: 4,
  };

  it('renders phase label, emojis, and elapsed times for every phase', () => {
    const cases: Array<[string, string, string]> = [
      ['questioning', '❓', 'Questioning'],
      ['spec_review', '📋', 'Spec Review'],
      ['implementation', '🏗️', 'Implementation'],
      ['task_review', '📝', 'Task Review'],
      ['executing', '⚡', 'Executing'],
      ['done', '✅', 'Done'],
    ];
    for (const [phase, emoji, label] of cases) {
      const out = formatSddStatusView(
        { ...baseSession, phase: phase as never },
        null,
        null,
        1000,
        2000,
        renderProgress,
        formatElapsed,
      );
      expect(out).toContain(`${emoji} Phase: ${label}`);
      expect(out).toContain('⏱ 2s');
      expect(out).toContain('⏱ Session: 1s');
      expect(out).toContain('Questions: 4');
    }
  });

  it('renders the spec block with up to 4 requirements and a "+N more" line', () => {
    const requirements = Array.from({ length: 6 }, (_, i) => ({
      id: `r${i}`,
      type: 'functional' as const,
      description: `Requirement ${i}`,
      priority: 'medium' as const,
      acceptanceCriteria: [],
    }));
    const out = formatSddStatusView(
      {
        ...baseSession,
        phase: 'spec_review',
        spec: {
          id: 's1',
          title: 'Spec Title',
          version: '1.0.0',
          status: 'draft',
          overview: '',
          sections: [],
          requirements,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      null,
      null,
      0,
      0,
      renderProgress,
      formatElapsed,
    );
    expect(out).toContain('📋 Spec: Spec Title');
    expect(out).toContain('6 requirements');
    expect(out).toContain('• [medium] Requirement 3');
    expect(out).not.toContain('Requirement 4\n');
    expect(out).toContain('+ 2 more requirements');
  });

  it('truncates requirement descriptions longer than 42 characters', () => {
    const long = 'R'.repeat(60);
    const out = formatSddStatusView(
      {
        ...baseSession,
        phase: 'spec_review',
        spec: {
          id: 's1',
          title: 'S',
          version: '1',
          status: 'draft',
          overview: '',
          sections: [],
          requirements: [
            { id: 'r1', type: 'functional' as const, description: long, priority: 'high' as const, acceptanceCriteria: [] },
          ],
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      null,
      null,
      0,
      0,
      renderProgress,
      formatElapsed,
    );
    expect(out).toContain(`${'R'.repeat(41)}…`);
  });

  it('shows plan commands when there is no progress', () => {
    const out = formatSddStatusView(baseSession, null, null, 0, 0, renderProgress, formatElapsed);
    expect(out).toContain('Commands: /sdd plan · /sdd approve · /sdd cancel');
  });

  it('shows task breakdown counters for every non-zero bucket', () => {
    const out = formatSddStatusView(
      baseSession,
      progress({ total: 9, inProgress: 1, pending: 2, blocked: 3, failed: 4, review: 5 }),
      null,
      0,
      0,
      renderProgress,
      formatElapsed,
    );
    expect(out).toContain('🔄 1 in progress');
    expect(out).toContain('⏳ 2 pending');
    expect(out).toContain('🚫 3 blocked');
    expect(out).toContain('❌ 4 failed');
    expect(out).toContain('👁 5 in review');
    expect(out).toContain('Commands: /sdd tasks · /sdd next · /sdd approve · /sdd cancel');
  });

  it('omits zero buckets from the task breakdown', () => {
    const out = formatSddStatusView(
      baseSession,
      progress({ total: 1, pending: 0 }),
      null,
      0,
      0,
      renderProgress,
      formatElapsed,
    );
    expect(out).not.toContain('in progress');
    expect(out).not.toContain('pending');
  });

  it('lists up to 3 startable pending tasks under "Up next"', () => {
    const pending = Array.from({ length: 5 }, (_, i) =>
      node({ id: `p${i}`, title: `Ready ${i}`, status: 'pending' }),
    );
    const tracker = {
      getAllNodes: (filter?: { status?: TaskNode['status'][] }) =>
        filter?.status ? pending.filter((n) => filter.status?.includes(n.status)) : pending,
      canStart: (id: string) => id !== 'p0',
    };
    const out = formatSddStatusView(
      baseSession,
      progress({ total: 5 }),
      tracker,
      0,
      0,
      renderProgress,
      formatElapsed,
    );
    expect(out).toContain('Up next:');
    expect(out).toContain('1. Ready 1');
    expect(out).toContain('3. Ready 3');
    expect(out).not.toContain('Ready 4');
    expect(out).not.toContain('Ready 0');
  });

  it('skips the "Up next" block when no pending task can start', () => {
    const tracker = {
      getAllNodes: () => [node({ status: 'pending' })],
      canStart: () => false,
    };
    const out = formatSddStatusView(baseSession, progress(), tracker, 0, 0, renderProgress, formatElapsed);
    expect(out).not.toContain('Up next:');
  });

  it('ignores a null taskTracker but still renders progress', () => {
    const out = formatSddStatusView(baseSession, progress(), null, 0, 0, renderProgress, formatElapsed);
    expect(out).toContain('progress 0/1');
    expect(out).not.toContain('Up next:');
  });

  it('uses the last path segment of the session id, sliced to 12 characters', () => {
    const out = formatSddStatusView(baseSession, null, null, 0, 0, renderProgress, formatElapsed);
    expect(out).toContain('Session ID: long-session…');
  });

  it('uses the whole id when it contains no path separator', () => {
    const out = formatSddStatusView(
      { ...baseSession, id: 'flat-id' },
      null,
      null,
      0,
      0,
      renderProgress,
      formatElapsed,
    );
    expect(out).toContain('Session ID: flat-id…');
  });

  it('treats zero-total progress like missing progress', () => {
    const out = formatSddStatusView(
      baseSession,
      progress({ total: 0 }),
      null,
      0,
      0,
      renderProgress,
      formatElapsed,
    );
    expect(out).toContain('Commands: /sdd plan');
  });
});

describe('formatGraphListFallback', () => {
  it('renders progress then numbered tasks with icon and priority', () => {
    const out = formatGraphListFallback(
      [node({ title: 'Alpha', priority: 'high' })],
      progress({ total: 1 }),
      renderProgress,
    );
    expect(out.split('\n')[0]).toBe('progress 0/1');
    expect(out).toContain('1. ⏳ [high] Alpha');
  });

  it('skips holes in the node array', () => {
    const sparse = [node(), undefined as unknown as TaskNode, node({ id: 't2' })];
    const out = formatGraphListFallback(sparse, progress({ total: 2 }), renderProgress);
    expect(out).not.toContain('undefined');
    expect(out).toContain('3. ⏳ [medium] Task');
  });
});

describe('formatCriticalPathAnalysis', () => {
  function graphWith(nodes: TaskNode[]): TaskGraph {
    return {
      id: 'g1',
      specId: 's1',
      title: 'Graph',
      nodes: new Map(nodes.map((n) => [n.id, n])),
      edges: [],
      rootNodes: nodes.map((n) => n.id),
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  function analysis(overrides: Partial<CriticalPathAnalysis> = {}): CriticalPathAnalysis {
    return {
      criticalPath: [],
      totalHours: 0,
      bottlenecks: [],
      parallelGroups: [],
      executionOrder: [],
      readyTasks: [],
      blockedTasks: [],
      ...overrides,
    };
  }

  it('renders only the header for an empty analysis', () => {
    const out = formatCriticalPathAnalysis(graphWith([]), analysis());
    expect(out).toContain('Critical path length: 0 tasks');
    expect(out).toContain('Estimated total time: 0h');
    expect(out).not.toContain('Bottlenecks');
    expect(out).not.toContain('Parallel groups');
    expect(out).not.toContain('Ready to start');
  });

  it('lists critical path nodes with estimate hours', () => {
    const out = formatCriticalPathAnalysis(
      graphWith([node({ id: 'a', title: 'Path A', priority: 'critical', estimateHours: 4 })]),
      analysis({ criticalPath: ['a', 'missing'], totalHours: 4 }),
    );
    expect(out).toContain('Critical path length: 2 tasks');
    expect(out).toContain('1. Path A [critical] — 4h');
  });

  it('silently skips critical path ids missing from the graph', () => {
    const out = formatCriticalPathAnalysis(graphWith([]), analysis({ criticalPath: ['ghost'] }));
    expect(out).not.toMatch(/^\s+1\./m);
  });

  it('renders bottlenecks with blocked counts', () => {
    const out = formatCriticalPathAnalysis(
      graphWith([node({ id: 'b', title: 'Bottleneck' })]),
      analysis({
        bottlenecks: [
          { taskId: 'b', title: 'Bottleneck', blockedCount: 7, blockedHours: 12, severity: 90 },
        ],
      }),
    );
    expect(out).toContain('Bottlenecks (blocking most downstream):');
    expect(out).toContain('• Bottleneck (blocks 7 task(s))');
  });

  it('skips bottleneck ids missing from the graph', () => {
    const out = formatCriticalPathAnalysis(
      graphWith([]),
      analysis({
        bottlenecks: [{ taskId: 'ghost', title: 'Ghost', blockedCount: 1, blockedHours: 2, severity: 10 }],
      }),
    );
    expect(out).not.toContain('Ghost');
  });

  it('renders parallel groups, using ? for unknown members', () => {
    const out = formatCriticalPathAnalysis(
      graphWith([node({ id: 'a', title: 'A' })]),
      analysis({ parallelGroups: [['a', 'ghost'], ['b-missing']] }),
    );
    expect(out).toContain('Group 1: A | ?');
    expect(out).toContain('Group 2: ?');
  });

  it('renders ready-to-start tasks', () => {
    const out = formatCriticalPathAnalysis(
      graphWith([node({ id: 'r', title: 'Ready one' })]),
      analysis({ readyTasks: ['r', 'ghost'] }),
    );
    expect(out).toContain('✅ Ready to start now:');
    expect(out).toContain('• Ready one');
  });
});
