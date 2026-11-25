import { describe, expect, it } from 'vitest';
import { exportBoardAsMarkdown } from '../src/manager/serialization.js';
import type { KanbanBoard } from '../src/types.js';

describe('exportBoardAsMarkdown (F2167)', () => {
  it('orders finite column and task orders deterministically when NaN orders are present', () => {
    const md = exportBoardAsMarkdown({
      id: 'b1',
      title: 'Board',
      columns: [
        { id: 'c2', title: 'Second', order: 2 },
        { id: 'cnan', title: 'Unknown', order: Number.NaN },
        { id: 'c1', title: 'First', order: 1 },
      ],
      tasks: [
        { id: 't2', title: 'T2', columnId: 'c1', status: 'todo', priority: 'medium', order: 2 },
        {
          id: 'tnan',
          title: 'TNan',
          columnId: 'c1',
          status: 'todo',
          priority: 'medium',
          order: Number.NaN,
        },
        { id: 't1', title: 'T1', columnId: 'c1', status: 'todo', priority: 'medium', order: 1 },
      ],
    } as unknown as KanbanBoard);

    expect(md.indexOf('## First')).toBeLessThan(md.indexOf('## Second'));
    expect(md.indexOf('## Second')).toBeLessThan(md.indexOf('## Unknown'));
    expect(md.indexOf('- [ ] T1')).toBeLessThan(md.indexOf('- [ ] T2'));
    expect(md.indexOf('- [ ] T2')).toBeLessThan(md.indexOf('- [ ] TNan'));
  });
});
