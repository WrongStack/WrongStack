import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBoard,
  getBoard,
  updateCheckOnTask,
  upsertContractNode,
} from './helpers/session-manager.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-check-identity-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const board = await createBoard(root, {
    title: 'Immutable criterion identity',
    tasks: [
      {
        id: 'task-identity',
        title: 'Keep references stable',
        successCriteria: [
          { id: 'original', description: 'Original criterion', type: 'manual', status: 'pending' },
          { id: 'other', description: 'Other criterion', type: 'manual', status: 'pending' },
        ],
      },
    ],
  });
  await upsertContractNode(root, board.id, {
    id: 'bound-guardrail',
    taskId: 'task-identity',
    title: 'Bound criterion',
    kind: 'guardrail',
    checkId: 'original',
  });
  return board;
}

describe('acceptance criterion identity at the update boundary', () => {
  it('updates mutable fields without replacing identity', async () => {
    const board = await fixture();
    await updateCheckOnTask(root, board.id, 'task-identity', 'original', { notes: 'New notes' });
    const current = await getBoard(root, board.id);
    expect(current?.tasks[0]?.successCriteria?.[0]).toMatchObject({
      id: 'original',
      notes: 'New notes',
    });
  });

  it.each(['renamed', 'other', '', null, undefined, 42])(
    'does not apply the extra patch ID %j or break its contract binding',
    async (id) => {
      const board = await fixture();
      // Structurally valid mutable patch with an extra field, as IPC can supply.
      const patch = { id, notes: 'Updated legitimate field' };
      await updateCheckOnTask(root, board.id, 'task-identity', 'original', patch);
      const current = await getBoard(root, board.id);
      expect(current?.tasks[0]?.successCriteria?.map((check) => check.id)).toEqual([
        'original',
        'other',
      ]);
      expect(current?.tasks[0]?.successCriteria?.[0]?.notes).toBe('Updated legitimate field');
      expect(current?.contractGraph?.nodes[0]?.checkId).toBe('original');
      const next = await updateCheckOnTask(root, board.id, 'task-identity', 'original', {
        status: 'passed',
      });
      expect(next?.tasks[0]?.successCriteria?.[0]?.status).toBe('passed');
      expect(next?.tasks[0]?.successCriteria?.[1]?.status).toBe('pending');
    },
  );
});
