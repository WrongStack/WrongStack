import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskGraph } from '../src/types/task-graph.js';
import {
  buildTaskGraphFromKanbanBoard,
  createBoardFromTaskGraph,
  removeTask,
  syncBoardFromTaskGraph,
} from './helpers/session-manager.js';

describe('Kanban task graph requirement coverage', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-requirements-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  function graph(): TaskGraph {
    const now = Date.now();
    return {
      id: 'graph-1',
      specId: 'spec-1',
      requiredRequirementIds: ['REQ-1'],
      title: 'Covered graph',
      nodes: new Map([
        [
          'node-1',
          {
            id: 'node-1',
            title: 'Implement requirement',
            description: 'Detailed implementation task.',
            type: 'feature',
            priority: 'high',
            status: 'pending',
            specRequirementId: 'REQ-1',
            createdAt: now,
            updatedAt: now,
          },
        ],
      ]),
      edges: [],
      rootNodes: ['node-1'],
      createdAt: now,
      updatedAt: now,
    };
  }

  it('round-trips spec and requirement identities without conflating them', async () => {
    const imported = await createBoardFromTaskGraph(projectRoot, graph());
    const task = imported.board.tasks[0]!;

    expect(imported.board.requiredRequirementIds).toEqual(['REQ-1']);
    expect(imported.board.requirementScopes).toEqual([
      expect.objectContaining({ graphId: 'graph-1', requirementIds: ['REQ-1'] }),
    ]);
    expect(task.origin).toMatchObject({ specId: 'spec-1', specRequirementId: 'REQ-1' });

    const exported = buildTaskGraphFromKanbanBoard(imported.board);
    expect(exported.graph.requiredRequirementIds).toEqual(['REQ-1']);
    expect(Array.from(exported.graph.nodes.values())[0]?.specRequirementId).toBe('REQ-1');
  });

  it('rejects an imported graph with omitted declared requirements', async () => {
    const invalid = graph();
    invalid.requiredRequirementIds = ['REQ-1', 'REQ-2'];

    await expect(createBoardFromTaskGraph(projectRoot, invalid)).rejects.toThrow(
      'missing task coverage for REQ-2',
    );
  });

  it('cannot delete the last Kanban task covering a declared requirement', async () => {
    const imported = await createBoardFromTaskGraph(projectRoot, graph());

    await expect(
      removeTask(projectRoot, imported.board.id, imported.board.tasks[0]!.id),
    ).rejects.toThrow('Cannot remove the last task covering required requirement REQ-1');
  });

  it('does not let an ordinary sync shrink a previously declared graph scope', async () => {
    const initial = graph();
    initial.requiredRequirementIds = ['REQ-1', 'REQ-2'];
    const now = Date.now();
    initial.nodes.set('node-2', {
      id: 'node-2',
      title: 'Second requirement',
      description: 'Second implementation task.',
      type: 'feature',
      priority: 'high',
      status: 'pending',
      specRequirementId: 'REQ-2',
      createdAt: now,
      updatedAt: now,
    });
    initial.rootNodes.push('node-2');
    const imported = await createBoardFromTaskGraph(projectRoot, initial);

    await expect(syncBoardFromTaskGraph(projectRoot, imported.board.id, graph())).rejects.toThrow(
      'requirement scope cannot shrink',
    );
  });

  it('keeps same-named requirements isolated by graph when deleting cards', async () => {
    const imported = await createBoardFromTaskGraph(projectRoot, graph());
    const second = graph();
    second.id = 'graph-2';
    second.specId = 'spec-2';
    const secondNode = second.nodes.get('node-1')!;
    second.nodes = new Map([['node-2', { ...secondNode, id: 'node-2', title: 'Other graph' }]]);
    second.rootNodes = ['node-2'];
    const synced = await syncBoardFromTaskGraph(projectRoot, imported.board.id, second);
    expect(synced?.board.requirementScopes).toHaveLength(2);

    const firstTask = synced!.board.tasks.find((task) => task.origin?.graphId === 'graph-1')!;
    await expect(removeTask(projectRoot, imported.board.id, firstTask.id)).rejects.toThrow(
      'Cannot remove the last task covering required requirement REQ-1',
    );
  });
});
