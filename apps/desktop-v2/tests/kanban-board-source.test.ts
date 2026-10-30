import { describe, expect, it } from 'vitest';
import { boardSource, runBoardId } from '../src/kanban-board-source';

const board = (id: string, tags: string[], updatedAt = '2026-10-30T10:00:00.000Z') => ({
  id,
  tags,
  updatedAt,
});

describe('run mirror board source', () => {
  it('reads the run a mirror board belongs to from its tags', () => {
    expect(boardSource(board('b1', ['goal', 'run:g1', 'graph:g1', 'phase:p2']))).toEqual({
      system: 'goal',
      runId: 'g1',
      phaseId: 'p2',
    });
    expect(boardSource(board('b2', ['sdd', 'run:r1', 'graph:t1']))).toEqual({
      system: 'sdd',
      runId: 'r1',
      phaseId: '',
    });
    expect(boardSource(board('b3', ['goal']))).toBeNull();
    expect(boardSource(board('b4', ['run:x']))).toBeNull();
    expect(boardSource(null)).toBeNull();
  });
  it('finds the requested phase board, else the newest board of the run', () => {
    const boards = [
      board('old', ['goal', 'run:g1', 'phase:p1'], '2026-10-30T09:00:00.000Z'),
      board('new', ['goal', 'run:g1', 'phase:p2'], '2026-10-30T11:00:00.000Z'),
      board('other', ['goal', 'run:g2', 'phase:p1'], '2026-10-30T12:00:00.000Z'),
      board('sdd', ['sdd', 'run:g1'], '2026-10-30T13:00:00.000Z'),
    ];
    expect(runBoardId(boards, { system: 'goal', runId: 'g1', phaseId: 'p1' })).toBe('old');
    expect(runBoardId(boards, { system: 'goal', runId: 'g1' })).toBe('new');
    expect(runBoardId(boards, { system: 'goal', runId: 'g1', phaseId: 'p9' })).toBe('new');
    expect(runBoardId(boards, { system: 'sdd', runId: 'g1' })).toBe('sdd');
    expect(runBoardId(boards, { system: 'goal', runId: 'missing' })).toBe('');
  });
});
