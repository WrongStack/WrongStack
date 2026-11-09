import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeBoard } from '../src/storage.js';
import type { TaskGraph } from '../src/types/task-graph.js';
import {
  createBoardFromTaskGraph,
  getBoard,
  removeTask,
  syncBoardFromTaskGraph,
} from './helpers/session-manager.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-requirement-scope-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function graph(requiredRequirementIds = ['REQ-1']): TaskGraph {
  return {
    id: 'graph',
    specId: 'spec',
    title: 'Requirement identity',
    requiredRequirementIds,
    nodes: new Map([
      [
        'task',
        {
          id: 'task',
          title: 'Required work',
          description: 'Implement REQ-1',
          type: 'feature',
          priority: 'medium',
          status: 'pending',
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

describe('requirement identity normalization at graph import and sync', () => {
  it.each(['import', 'sync'])(
    'keeps last-covering-task protection after %s of padded declarations',
    async (operation) => {
      const source = graph([' REQ-1 ']);
      const imported = await createBoardFromTaskGraph(
        root,
        operation === 'import' ? source : graph(),
      );
      if (operation === 'sync') await syncBoardFromTaskGraph(root, imported.board.id, source);
      const board = await getBoard(root, imported.board.id);
      const task = board?.tasks[0];
      if (!board || !task) throw new Error('Fixture board/task missing');
      await expect(removeTask(root, board.id, task.id)).rejects.toThrow(
        'Cannot remove the last task covering required requirement REQ-1',
      );
      expect(await getBoard(root, board.id)).toEqual(board);
    },
  );

  it('persists the same trimmed, nonblank identity set that validation accepts', async () => {
    const imported = await createBoardFromTaskGraph(root, graph([' REQ-1 ', '', 'REQ-1', '\t']));
    const board = await getBoard(root, imported.board.id);
    expect(board?.requiredRequirementIds).toEqual(['REQ-1']);
    expect(board?.requirementScopes?.[0]?.requirementIds).toEqual(['REQ-1']);
    await expect(syncBoardFromTaskGraph(root, imported.board.id, graph())).resolves.toBeTruthy();
  });

  it('does not mistake normalization of an older stored scope for scope removal', async () => {
    const imported = await createBoardFromTaskGraph(root, graph());
    imported.board.requiredRequirementIds = [' REQ-1 '];
    const scope = imported.board.requirementScopes?.[0];
    if (!scope) throw new Error('Fixture requirement scope missing');
    scope.requirementIds = [' REQ-1 '];
    await writeBoard(root, imported.board);
    await expect(syncBoardFromTaskGraph(root, imported.board.id, graph())).resolves.toBeTruthy();
    const repaired = await getBoard(root, imported.board.id);
    expect(repaired?.requiredRequirementIds).toEqual(['REQ-1']);
  });
});
