import { describe, expect, it } from 'vitest';
import { boardPassesKindFilter, resolveKindFilter } from '../src/manager/board-kind-filter.js';
import type { KanbanBoard } from '../src/types.js';

describe('resolveKindFilter (F2210)', () => {
  it('honors an explicit empty includeBoardKinds=[] instead of falling back to defaults', () => {
    const empty = resolveKindFilter({ includeBoardKinds: [] });
    expect(boardPassesKindFilter({ kind: 'project' } as unknown as KanbanBoard, empty)).toBe(false);

    const def = resolveKindFilter(undefined);
    expect(boardPassesKindFilter({ kind: 'project' } as unknown as KanbanBoard, def)).toBe(true);
  });
});
