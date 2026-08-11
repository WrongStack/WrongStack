/**
 * Tests for exportBoardAsMarkdown — the pure formatter behind the
 * `/kanban export` slash command. Previously this user-facing surface had
 * zero test coverage anywhere in the repo.
 */
import { describe, expect, it } from 'vitest';
import { exportBoardAsMarkdown } from '../src/manager/serialization.js';
import type { KanbanBoard } from '../src/types.js';

function makeBoard(overrides: Partial<KanbanBoard> = {}): KanbanBoard {
  return {
    id: 'b1',
    title: 'Test Board',
    columns: [
      { id: 'todo', title: 'To Do', order: 0, wipLimit: 0 },
      { id: 'done', title: 'Done', order: 1, wipLimit: 0 },
    ],
    tasks: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

describe('exportBoardAsMarkdown', () => {
  it('renders an empty board with column headers and _Empty_ markers', () => {
    const md = exportBoardAsMarkdown(makeBoard());
    expect(md).toContain('# Test Board');
    expect(md).toContain('## To Do');
    expect(md).toContain('## Done');
    expect(md).toContain('_Empty_');
    expect(md).toContain('Exported from WrongStack Kanban: b1');
  });

  it('renders tasks under their columns with completion checkboxes', () => {
    const board = makeBoard({
      tasks: [
        {
          id: 't1',
          title: 'Pending task',
          description: 'Some work.',
          status: 'pending',
          columnId: 'todo',
          order: 0,
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 't2',
          title: 'Finished task',
          status: 'completed',
          columnId: 'done',
          order: 0,
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const md = exportBoardAsMarkdown(board);
    // Unchecked for pending, checked for completed.
    expect(md).toContain('- [ ] Pending task');
    expect(md).toContain('  Some work.');
    expect(md).toContain('- [x] Finished task');
  });

  it('renders assignee and non-medium priority badges', () => {
    const board = makeBoard({
      tasks: [
        {
          id: 't1',
          title: 'Urgent',
          status: 'in_progress',
          columnId: 'todo',
          order: 0,
          priority: 'critical',
          assignedAgent: 'agent-7',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const md = exportBoardAsMarkdown(board);
    expect(md).toContain('@agent-7');
    expect(md).toContain('!critical');
  });

  it('escapes nothing special but preserves titles with special characters', () => {
    // Titles with characters that matter in Markdown (backticks, pipes, hashes)
    // should pass through verbatim — this is an export, not a sanitiser.
    const board = makeBoard({
      tasks: [
        {
          id: 't1',
          title: 'Fix `code` block | edge #case',
          status: 'pending',
          columnId: 'todo',
          order: 0,
          priority: 'medium',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const md = exportBoardAsMarkdown(board);
    expect(md).toContain('Fix `code` block | edge #case');
  });

  it('renders board description and tags when present', () => {
    const board = makeBoard({
      description: 'A sprint board.',
      tags: ['sprint-42', 'backend'],
    });
    const md = exportBoardAsMarkdown(board);
    expect(md).toContain('A sprint board.');
    expect(md).toContain('Tags: #sprint-42 #backend');
  });
});
