import { describe, expect, it } from 'vitest';
import { auditKanbanBoard } from '../../src/lib/kanban-cleaner';

/**
 * The lifecycle/review policy resolution and the lifecycle-skip detector.
 * Both read the board's policy from one of several historical spellings, so
 * each accepted shape gets a case here.
 */

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/** A task with every "required detail" satisfied, so only the branch under
 *  test can produce an issue. */
function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    title: 'Task one',
    status: 'todo',
    description: 'has one',
    labels: ['x'],
    childTaskIds: ['c1'],
    successCriteria: ['works'],
    assignment: { agentId: 'sa1' },
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function board(overrides: Record<string, unknown> = {}) {
  return { id: 'b1', columns: [], tasks: [task()], ...overrides } as never;
}

function audit(b: unknown, options: Record<string, unknown> = {}) {
  return auditKanbanBoard(b as never, { now: NOW, ...options } as never);
}

function codes(b: unknown, options: Record<string, unknown> = {}) {
  return audit(b, options).issues.map((i) => i.code);
}

describe('current time', () => {
  it('accepts an epoch number', () => {
    expect(() => auditKanbanBoard(board(), { now: NOW } as never)).not.toThrow();
  });

  it('accepts an ISO string', () => {
    expect(() =>
      auditKanbanBoard(board(), { now: '2026-07-29T12:00:00.000Z' } as never),
    ).not.toThrow();
  });

  it('accepts a Date', () => {
    expect(() => auditKanbanBoard(board(), { now: new Date(NOW) } as never)).not.toThrow();
  });

  it('rejects an unparseable time rather than auditing against NaN', () => {
    expect(() => auditKanbanBoard(board(), { now: 'yesterday' } as never)).toThrow(TypeError);
  });

  it('rejects an invalid Date', () => {
    expect(() => auditKanbanBoard(board(), { now: new Date('nope') } as never)).toThrow(TypeError);
  });
});

describe('review staleness policy', () => {
  const reviewTask = task({
    status: 'review',
    updatedAt: new Date(NOW - 30 * HOUR).toISOString(),
  });

  it('uses the caller default when the board has no policy', () => {
    const b = board({ tasks: [reviewTask] });
    expect(codes(b, { defaultReviewStaleAfterMs: 100 * HOUR })).not.toContain('stale-review');
    expect(codes(b, { defaultReviewStaleAfterMs: HOUR })).toContain('stale-review');
  });

  it.each([
    ['staleReviewAfterMs', { staleReviewAfterMs: 100 * HOUR }],
    ['reviewStaleAfterMs', { reviewStaleAfterMs: 100 * HOUR }],
    ['reviewStaleHours', { reviewStaleHours: 100 }],
  ])('reads the board-level %s', (_name, policy) => {
    const b = board({ tasks: [reviewTask], ...policy });
    expect(codes(b, { defaultReviewStaleAfterMs: HOUR })).not.toContain('stale-review');
  });

  it.each(['lifecycle', 'lifecyclePolicy', 'managedLifecycle'])(
    'reads the policy nested under %s',
    (key) => {
      const b = board({ tasks: [reviewTask], [key]: { staleReviewAfterMs: 100 * HOUR } });
      expect(codes(b, { defaultReviewStaleAfterMs: HOUR })).not.toContain('stale-review');
    },
  );

  it('ignores a non-positive threshold and falls back', () => {
    const b = board({ tasks: [reviewTask], staleReviewAfterMs: 0 });
    expect(codes(b, { defaultReviewStaleAfterMs: HOUR })).toContain('stale-review');
  });

  it('ignores an array where a policy object was expected', () => {
    const b = board({ tasks: [reviewTask], lifecycle: [1, 2, 3] });
    expect(codes(b, { defaultReviewStaleAfterMs: HOUR })).toContain('stale-review');
  });

  it('reports the wait in whole hours', () => {
    const b = board({ tasks: [reviewTask] });
    const issue = audit(b, { defaultReviewStaleAfterMs: HOUR }).issues.find(
      (i) => i.code === 'stale-review',
    );
    expect(issue?.message).toBe('Waiting in review for 30h');
  });

  it('floors a sub-hour overrun at 1h rather than 0h', () => {
    const b = board({
      tasks: [task({ status: 'review', updatedAt: new Date(NOW - 90_000).toISOString() })],
    });
    const issue = audit(b, { defaultReviewStaleAfterMs: 1_000 }).issues.find(
      (i) => i.code === 'stale-review',
    );
    expect(issue?.message).toBe('Waiting in review for 1h');
  });

  it('prefers the lifecycle entry timestamp over updatedAt', () => {
    const b = board({
      tasks: [
        task({
          status: 'review',
          updatedAt: new Date(NOW - 100 * HOUR).toISOString(),
          lifecycle: {
            history: [{ status: 'review', at: new Date(NOW - HOUR).toISOString() }],
          },
        }),
      ],
    });
    expect(codes(b, { defaultReviewStaleAfterMs: 10 * HOUR })).not.toContain('stale-review');
  });

  it('says nothing when the review entry time is unknown', () => {
    const b = board({ tasks: [task({ status: 'review', updatedAt: undefined })] });
    expect(codes(b, { defaultReviewStaleAfterMs: 1 })).not.toContain('stale-review');
  });
});

describe('lifecycle order resolution', () => {
  const skipper = task({
    lifecycle: {
      history: [
        { status: 'backlog', at: NOW - 3 * HOUR },
        { status: 'review', at: NOW - HOUR },
      ],
    },
  });

  it('reads a plain string array', () => {
    const b = board({ tasks: [skipper], lifecycle: ['backlog', 'todo', 'running', 'review'] });
    expect(codes(b)).toContain('skipped-lifecycle-state');
  });

  it('reads objects with an id/status/state/name', () => {
    const b = board({
      tasks: [skipper],
      lifecycle: [{ id: 'backlog' }, { status: 'todo' }, { state: 'running' }, { name: 'review' }],
    });
    expect(codes(b)).toContain('skipped-lifecycle-state');
  });

  it('reads a managed policy with a column map', () => {
    const b = board({
      tasks: [skipper],
      lifecyclePolicy: {
        mode: 'managed',
        columns: {
          backlog: 'backlog',
          todo: 'todo',
          running: 'running',
          review: 'review',
          done: 'done',
        },
      },
    });
    expect(codes(b)).toContain('skipped-lifecycle-state');
  });

  it('ignores a managed policy missing a stage', () => {
    const b = board({
      tasks: [skipper],
      lifecyclePolicy: { mode: 'managed', columns: { backlog: 'backlog', todo: 'todo' } },
    });
    expect(codes(b)).not.toContain('skipped-lifecycle-state');
  });

  it.each(['states', 'statuses', 'order', 'managedStatuses'])(
    'reads the order from policy.%s',
    (key) => {
      const b = board({
        tasks: [skipper],
        lifecycle: { [key]: ['backlog', 'todo', 'running', 'review'] },
      });
      expect(codes(b)).toContain('skipped-lifecycle-state');
    },
  );

  it('does nothing with a single-state order', () => {
    const b = board({ tasks: [skipper], lifecycle: ['backlog'] });
    expect(codes(b)).not.toContain('skipped-lifecycle-state');
  });

  it('does nothing with no policy at all', () => {
    expect(codes(board({ tasks: [skipper] }))).not.toContain('skipped-lifecycle-state');
  });
});

describe('lifecycle skip detection', () => {
  const order = ['backlog', 'todo', 'running', 'review', 'done'];

  function withHistory(history: unknown) {
    return board({ tasks: [task({ lifecycle: { history } })], lifecycle: order });
  }

  it('flags a two-step jump', () => {
    expect(
      codes(withHistory([{ status: 'backlog', at: 1 }, { status: 'running', at: 2 }])),
    ).toContain('skipped-lifecycle-state');
  });

  it('allows an adjacent move', () => {
    expect(
      codes(withHistory([{ status: 'backlog', at: 1 }, { status: 'todo', at: 2 }])),
    ).not.toContain('skipped-lifecycle-state');
  });

  it('allows a single-step move backwards', () => {
    expect(
      codes(withHistory([{ status: 'review', at: 1 }, { status: 'running', at: 2 }])),
    ).not.toContain('skipped-lifecycle-state');
  });

  it('needs at least two entries', () => {
    expect(codes(withHistory([{ status: 'backlog', at: 1 }]))).not.toContain('skipped-lifecycle-state');
  });

  it('ignores a state that is not in the declared order', () => {
    expect(
      codes(withHistory([{ status: 'nowhere', at: 1 }, { status: 'done', at: 2 }])),
    ).not.toContain('skipped-lifecycle-state');
  });

  it('ignores a non-array history', () => {
    expect(codes(withHistory('backlog'))).not.toContain('skipped-lifecycle-state');
  });

  it('accepts bare strings as history entries', () => {
    expect(codes(withHistory(['backlog', 'running']))).toContain('skipped-lifecycle-state');
  });

  it('skips an entry with no resolvable state', () => {
    expect(codes(withHistory([{ at: 1 }, { at: 2 }]))).not.toContain('skipped-lifecycle-state');
  });

  it.each(['status', 'state', 'toStatus', 'to', 'columnId'])(
    'reads the entry state from %s',
    (key) => {
      expect(
        codes(withHistory([{ [key]: 'backlog', at: 1 }, { [key]: 'running', at: 2 }])),
      ).toContain('skipped-lifecycle-state');
    },
  );

  it.each(['lifecycleHistory', 'statusHistory', 'history'])(
    'reads the history from task.%s',
    (key) => {
      const b = board({
        tasks: [task({ [key]: ['backlog', 'running'] })],
        lifecycle: order,
      });
      expect(codes(b)).toContain('skipped-lifecycle-state');
    },
  );
});

describe('issue ordering', () => {
  it('puts errors before warnings, then sorts by title and message', () => {
    const b = board({
      tasks: [
        task({ id: 'z', title: 'Zed', description: undefined }),
        task({ id: 'a', title: 'Alpha', description: undefined }),
        task({ id: 'r', title: 'Run', status: 'in_progress', assignment: undefined }),
      ],
    });
    const issues = audit(b).issues;

    expect(issues[0]?.severity).toBe('error');
    const warningTitles = issues.filter((i) => i.severity === 'warning').map((i) => i.taskTitle);
    expect(warningTitles.indexOf('Alpha')).toBeLessThan(warningTitles.indexOf('Zed'));
  });

  it('counts each severity and the distinct affected tasks', () => {
    const b = board({
      tasks: [
        task({ id: 'a', title: 'A', description: undefined }),
        task({ id: 'b', title: 'B', description: undefined }),
      ],
    });
    const summary = audit(b);

    expect(summary.affectedTaskCount).toBe(2);
    expect(summary.counts.warning).toBeGreaterThan(0);
    expect(summary.counts.error).toBe(0);
  });

  it('skips terminal tasks entirely', () => {
    const b = board({ tasks: [{ id: 'x', title: 'X', status: 'completed' }] });
    expect(audit(b).issues).toEqual([]);
  });
});
