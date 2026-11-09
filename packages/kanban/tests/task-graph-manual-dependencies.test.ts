import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeBoard } from '../src/storage.js';
import type { TaskGraph, TaskNode } from '../src/types/task-graph.js';
import {
  addDependency,
  addTask,
  createBoardFromTaskGraph,
  getBoard,
  syncBoardFromTaskGraph,
} from './helpers/session-manager.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-manual-deps-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const nodes = new Map<string, TaskNode>();
  for (const id of ['a', 'b', 'c']) {
    nodes.set(id, {
      id,
      title: id,
      description: `Work ${id}`,
      type: 'feature',
      priority: 'medium',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
    });
  }
  const graph: TaskGraph = {
    id: 'graph',
    specId: 'spec',
    title: 'Manual dependency preservation',
    nodes,
    edges: [{ id: 'source-edge', from: 'a', to: 'b', type: 'depends_on' }],
    rootNodes: ['a'],
    createdAt: 1,
    updatedAt: 1,
  };
  const imported = await createBoardFromTaskGraph(root, graph);
  const a = imported.taskIdMap.get('a');
  const b = imported.taskIdMap.get('b');
  const c = imported.taskIdMap.get('c');
  if (!a || !b || !c) throw new Error('Fixture failed to import all nodes');
  await addDependency(root, imported.board.id, c, a);
  return { boardId: imported.board.id, graph, a, b, c };
}

async function dependencies(boardId: string, taskId: string) {
  const board = await getBoard(root, boardId);
  const task = board?.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error('Fixture task missing');
  return task.dependsOn ?? [];
}

describe('manual dependencies during task-graph synchronization', () => {
  it.each([undefined, true])(
    'preserves a manual same-graph edge with option %j',
    async (option) => {
      const { boardId, graph, a, b, c } = await fixture();
      await syncBoardFromTaskGraph(root, boardId, graph, { preserveManualDependencies: option });
      expect(await dependencies(boardId, b)).toEqual([a]);
      expect(await dependencies(boardId, c)).toEqual([a]);
      await syncBoardFromTaskGraph(root, boardId, graph, { preserveManualDependencies: option });
      expect(await dependencies(boardId, c)).toEqual([a]);
    },
  );

  it('drops manual edges only when explicitly requested', async () => {
    const { boardId, graph, a, b, c } = await fixture();
    await syncBoardFromTaskGraph(root, boardId, graph, { preserveManualDependencies: false });
    expect(await dependencies(boardId, b)).toEqual([a]);
    expect(await dependencies(boardId, c)).toEqual([]);
  });

  it('removes obsolete source edges without removing manual edges', async () => {
    const { boardId, graph, a, b, c } = await fixture();
    graph.edges = [];
    await syncBoardFromTaskGraph(root, boardId, graph, { preserveManualDependencies: true });
    expect(await dependencies(boardId, b)).toEqual([]);
    expect(await dependencies(boardId, c)).toEqual([a]);
  });

  it('keeps conservative source-edge removal for legacy boards without provenance', async () => {
    const { boardId, graph, b } = await fixture();
    const external = await addTask(root, boardId, { title: 'Independent manual task' });
    if (!external) throw new Error('Fixture external task missing');
    await addDependency(root, boardId, b, external.task.id);
    const board = await getBoard(root, boardId);
    if (!board) throw new Error('Fixture board missing');
    for (const task of board.tasks) {
      if (task.origin) delete task.origin.sourceDependencyTaskIds;
    }
    await writeBoard(root, board);
    graph.edges = [];
    await syncBoardFromTaskGraph(root, boardId, graph, { preserveManualDependencies: true });
    expect(await dependencies(boardId, b)).toEqual([external.task.id]);
  });
});
