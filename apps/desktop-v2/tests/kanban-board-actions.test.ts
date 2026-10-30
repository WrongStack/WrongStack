import { describe, expect, it } from 'vitest';
import {
  BOARD_HISTORY_LIMIT,
  boardHistoryRows,
  deleteConfirmed,
} from '../src/kanban-board-actions';

const entry = (id: string, type: string, ts: string, extra: Record<string, unknown> = {}) => ({
  id,
  boardId: 'b1',
  boardTitle: 'Release',
  type,
  ts,
  ...extra,
});

describe('kanban board actions', () => {
  it('lists the engine history newest first with readable details', () => {
    const rows = boardHistoryRows([
      entry('1', 'board.created', '2026-10-30T09:00:00.000Z', { after: { kind: 'project' } }),
      entry('2', 'board.updated', '2026-10-30T10:00:00.000Z', { after: { title: 'x', tags: [] } }),
      entry('3', 'board.duplicated', '2026-10-30T11:00:00.000Z', {
        after: { sourceBoardTitle: 'Roadmap' },
      }),
      entry('4', 'board.lifecycle.adopted', '2026-10-30T12:00:00.000Z', {
        actor: 'leader',
        note: 'Managed now',
      }),
      entry('5', 'board.custom', '2026-10-30T13:00:00.000Z'),
      { type: 'board.deleted' },
    ]);
    expect(rows.map((row) => [row.label, row.detail])).toEqual([
      ['board.custom', ''],
      ['Lifecycle adopted', 'Managed now'],
      ['Duplicated', 'Copied from Roadmap'],
      ['Updated', 'Changed title, tags'],
      ['Created', ''],
    ]);
    expect(rows[1]?.actor).toBe('leader');
  });
  it('bounds the history', () => {
    const many = Array.from({ length: BOARD_HISTORY_LIMIT + 10 }, (_, index) =>
      entry(String(index), 'board.updated', new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()),
    );
    expect(boardHistoryRows(many)).toHaveLength(BOARD_HISTORY_LIMIT);
    expect(boardHistoryRows('nope')).toEqual([]);
  });
  it('requires the exact board title before a permanent delete', () => {
    expect(deleteConfirmed('Release', 'Release')).toBe(true);
    expect(deleteConfirmed('  Release ', 'Release')).toBe(true);
    expect(deleteConfirmed('release', 'Release')).toBe(false);
    expect(deleteConfirmed('', '')).toBe(false);
  });
});
