import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeProjectFixtureDirectory } from './helpers/remove-fixture-directory.js';
import {
  configureContractGraph,
  createBoard,
  evaluateTaskContractGraph,
  updateCheckOnTask,
  upsertContractNode,
} from './helpers/session-manager.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-contract-prefix-'));
});

afterEach(async () => {
  await removeProjectFixtureDirectory(root);
});

async function makeContract(enforcement: 'strict' | 'advisory' | 'off') {
  const board = await createBoard(root, {
    title: 'Task prefix contract',
    tasks: [
      {
        id: 'target-task-123',
        title: 'Verified work',
        successCriteria: [
          { id: 'check-1', description: 'Acceptance control', type: 'manual', status: 'passed' },
        ],
      },
      { id: 'other-task-123', title: 'Other work' },
    ],
  });
  await configureContractGraph(root, board.id, enforcement);
  for (const kind of ['objective', 'guardrail'] as const) {
    await upsertContractNode(root, board.id, {
      taskId: 'target-task-123',
      kind,
      title: kind,
      checkId: 'check-1',
    });
  }
  return board;
}

describe('contract graph task ID resolution', () => {
  it.each(['strict', 'advisory', 'off'] as const)(
    'evaluates a unique prefix like its full task ID in %s mode',
    async (enforcement) => {
      const board = await makeContract(enforcement);
      const full = await evaluateTaskContractGraph(root, board.id, 'target-task-123');
      expect(full?.evaluation.allowed).toBe(true);
      const prefix = await evaluateTaskContractGraph(root, board.id, 'target-task-');
      expect(prefix?.evaluation).toEqual(full?.evaluation);
    },
  );

  it('preserves unresolved issues when evaluating through a prefix', async () => {
    const board = await makeContract('strict');
    await updateCheckOnTask(root, board.id, 'target-task-123', 'check-1', { status: 'failed' });
    const full = await evaluateTaskContractGraph(root, board.id, 'target-task-123');
    expect(full?.evaluation.allowed).toBe(false);
    expect(full?.evaluation.issues.some((issue) => issue.code === 'node-unresolved')).toBe(true);
    const prefix = await evaluateTaskContractGraph(root, board.id, 'target-task-');
    expect(prefix?.evaluation).toEqual(full?.evaluation);
  });

  it('returns null for absent references and rejects ambiguous prefixes', async () => {
    const board = await createBoard(root, {
      title: 'Lookup boundaries',
      tasks: [
        { id: 'shared-one', title: 'One' },
        { id: 'shared-two', title: 'Two' },
      ],
    });
    await expect(evaluateTaskContractGraph(root, board.id, 'missing')).resolves.toBeNull();
    await expect(evaluateTaskContractGraph(root, board.id, '')).resolves.toBeNull();
    await expect(evaluateTaskContractGraph(root, board.id, 'shared-')).rejects.toThrow(
      'Ambiguous kanban task id',
    );
  });
});
