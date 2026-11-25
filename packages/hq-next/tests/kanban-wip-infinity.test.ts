import { describe, expect, it } from 'vitest';
import { columnLoad } from '../src/features/kanban/model';
import type { HqKanbanColumnView } from '../src/hq/domain/kanban-model';

describe('columnLoad wipLimit finite guard', () => {
  it('ignores non-finite wipLimit values like Infinity', () => {
    const res = columnLoad({
      id: 'c2',
      title: 'Todo',
      tasks: [{}],
      wipLimit: Number.POSITIVE_INFINITY,
    } as unknown as HqKanbanColumnView);
    expect(res.limit).toBeUndefined();
    expect(res.over).toBe(false);
  });
});
