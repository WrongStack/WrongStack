import { describe, expect, it } from 'vitest';
import { sameFieldConflicts, taskDefinitionPatch } from '../src/task-definition-model';

describe('task definition write contracts', () => {
  it('writes edited fields without reapplying the old assignment policy or worker state', () => {
    const baseline = {
      title: 'Before',
      description: 'Context',
      priority: 'high',
      retryPolicy: 'off',
      costCeilingUsd: 5,
      status: 'ready',
    };
    expect(
      taskDefinitionPatch(baseline, {
        title: 'After',
        description: 'Context',
        priority: 'high',
        retryPolicy: 'off',
        costCeilingUsd: 5,
        status: 'ready',
      }),
    ).toEqual({ title: 'After' });
  });
  it('preserves explicit optional-field clears and compares date-only controls without truncating untouched timestamps', () => {
    const baseline = { dueDate: '2026-12-20T15:30:00.000Z', costCeilingUsd: 5, dependsOn: ['a'] };
    expect(
      taskDefinitionPatch(baseline, { dueDate: '2026-12-20', costCeilingUsd: null, dependsOn: [] }),
    ).toEqual({ costCeilingUsd: null, dependsOn: [] });
  });
});

describe('same-field conflicts', () => {
  const baseline = { id: 't', title: 'Old', priority: 'low', labels: ['a'] };
  it('reports only fields both sides changed to different values', () => {
    const current = { ...baseline, title: 'Theirs', priority: 'high' };
    expect(sameFieldConflicts(baseline, current, { title: 'Mine', activityNote: 'x' })).toEqual([
      { field: 'title', theirs: 'Theirs', mine: 'Mine' },
    ]);
    // Their priority change is not in my patch, so it is not a conflict.
    expect(sameFieldConflicts(baseline, current, { labels: ['b'] })).toEqual([]);
    // The same new value on both sides is not a conflict.
    expect(sameFieldConflicts(baseline, current, { title: 'Theirs' })).toEqual([]);
    // Unchanged elsewhere: no conflict.
    expect(sameFieldConflicts(baseline, baseline, { title: 'Mine' })).toEqual([]);
  });
});
