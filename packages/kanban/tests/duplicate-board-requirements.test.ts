import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeBoard } from '../src/storage.js';
import type { TaskGraph } from '../src/types/task-graph.js';
import {
  buildTaskGraphFromKanbanBoard,
  createBoard,
  createBoardFromTaskGraph,
  duplicateBoard,
  getBoard,
  removeTask,
  syncBoardFromTaskGraph,
  transferTaskToBoard,
} from './helpers/session-manager.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-duplicate-requirements-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function graph(id = 'graph'): TaskGraph {
  return {
    id,
    specId: `spec-${id}`,
    title: 'Requirement-backed board',
    requiredRequirementIds: ['REQ-1'],
    nodes: new Map([
      [
        'task',
        {
          id: 'task',
          title: 'Required work',
          description: 'Implement REQ-1',
          type: 'feature',
          status: 'pending',
          priority: 'medium',
          specRequirementId: 'REQ-1',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]),
    edges: [],
    rootNodes: ['task'],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('duplicating requirement-backed boards', () => {
  it.each(['scoped', 'legacy'])(
    'preserves %s requirement protection and exported declarations',
    async (mode) => {
      const source = await createBoardFromTaskGraph(root, graph());
      if (mode === 'legacy') {
        delete source.board.requirementScopes;
        await writeBoard(root, source.board);
      }
      const copy = await duplicateBoard(root, source.board.id);
      const task = copy?.tasks[0];
      if (!copy || !task) throw new Error('Fixture duplicate task missing');
      expect(copy.requiredRequirementIds).toEqual(['REQ-1']);
      expect(copy.requirementScopes).toEqual(source.board.requirementScopes);
      expect(buildTaskGraphFromKanbanBoard(copy).graph.requiredRequirementIds).toEqual(['REQ-1']);
      await expect(removeTask(root, copy.id, task.id)).rejects.toThrow(
        'Cannot remove the last task covering required requirement REQ-1',
      );
      const target = await createBoard(root, { title: 'Transfer target' });
      await expect(transferTaskToBoard(root, copy.id, task.id, target.id)).rejects.toThrow(
        'Cannot remove the last task covering required requirement REQ-1',
      );
      expect((await getBoard(root, target.id))?.tasks).toEqual([]);
      expect((await getBoard(root, source.board.id))?.tasks).toHaveLength(1);
    },
  );

  it('keeps equal requirement names isolated by graph in the duplicate', async () => {
    const source = await createBoardFromTaskGraph(root, graph());
    await syncBoardFromTaskGraph(root, source.board.id, graph('other-graph'));
    const copy = await duplicateBoard(root, source.board.id);
    const task = copy?.tasks.find((candidate) => candidate.origin?.graphId === 'graph');
    if (!copy || !task) throw new Error('Fixture duplicate task missing');
    expect(copy.requirementScopes).toHaveLength(2);
    await expect(removeTask(root, copy.id, task.id)).rejects.toThrow(
      'Cannot remove the last task covering required requirement REQ-1',
    );
  });

  it('does not attach orphaned requirement declarations to a task-free template', async () => {
    const source = await createBoardFromTaskGraph(root, graph());
    const copy = await duplicateBoard(root, source.board.id, { includeTasks: false });
    expect(copy?.tasks).toEqual([]);
    expect(copy?.requiredRequirementIds).toBeUndefined();
    expect(copy?.requirementScopes).toBeUndefined();
  });

  it('leaves unscoped board duplicates unscoped', async () => {
    const source = await createBoard(root, { title: 'Unscoped board' });
    const copy = await duplicateBoard(root, source.id);
    expect(copy?.requiredRequirementIds).toBeUndefined();
    expect(copy?.requirementScopes).toBeUndefined();
  });
});
