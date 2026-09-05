/**
 * updateCheckOnTask must reset stale status/audit when the check TYPE
 * changes. Before this, a persisted `failed` from the old type (e.g. a
 * command run the verifier sandbox could not execute) kept failing verdicts
 * for the converted check even though the new type was never evaluated —
 * the exact trap that parked the markdown-table card on 2026-09-05.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { KanbanTask } from '../src/types.js';
import { addCheckToTask, addTask, createBoard, getBoard, updateCheckOnTask } from './helpers/session-manager.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-check-reset-'));
});

const taskOf = async (boardId: string, taskId: string): Promise<KanbanTask> => {
  const board = await getBoard(tmpDir, boardId);
  return board!.tasks.find((task) => task.id === taskId)!;
};

/** A card whose single command check has already been stamped `failed`. */
async function failedCommandCheck() {
  const board = await createBoard(tmpDir, { title: 'Reset board' });
  const added = await addTask(tmpDir, board.id, { title: 'Carrier task' });
  const taskId = added!.task.id;
  await addCheckToTask(tmpDir, board.id, taskId, {
    description: 'Runs the typecheck',
    type: 'command',
    status: 'pending',
    notes: 'tsc --noEmit',
  });
  const first = (await taskOf(board.id, taskId)).successCriteria![0]!;
  await updateCheckOnTask(tmpDir, board.id, taskId, first.id, { status: 'failed', checkedBy: 'system' });
  return { boardId: board.id, taskId, checkId: first.id };
}

describe('updateCheckOnTask type-change status reset', () => {
  it('resets a failed check to pending when its type changes, clearing the audit trail', async () => {
    const { boardId, taskId, checkId } = await failedCommandCheck();
    await updateCheckOnTask(tmpDir, boardId, taskId, checkId, { type: 'manual' });
    const check = (await taskOf(boardId, taskId)).successCriteria!.find((c) => c.id === checkId)!;
    expect(check.type).toBe('manual');
    expect(check.status).toBe('pending');
    expect(check.checkedAt).toBeUndefined();
    expect(check.checkedBy).toBeUndefined();
  });

  it('lets an explicit status patch win over the reset', async () => {
    const { boardId, taskId, checkId } = await failedCommandCheck();
    await updateCheckOnTask(tmpDir, boardId, taskId, checkId, {
      type: 'manual',
      status: 'passed',
      notes: 'Verified locally: tsc --noEmit exit 0.',
    });
    const check = (await taskOf(boardId, taskId)).successCriteria!.find((c) => c.id === checkId)!;
    expect(check.type).toBe('manual');
    expect(check.status).toBe('passed');
    expect(check.checkedAt).toBeDefined();
  });

  it('keeps the persisted status when the type does not change', async () => {
    const { boardId, taskId, checkId } = await failedCommandCheck();
    await updateCheckOnTask(tmpDir, boardId, taskId, checkId, { description: 'Runs the full typecheck' });
    const check = (await taskOf(boardId, taskId)).successCriteria!.find((c) => c.id === checkId)!;
    expect(check.status).toBe('failed');
    expect(check.checkedAt).toBeDefined();
  });

  it('does not reset when patching the same type it already has', async () => {
    const { boardId, taskId, checkId } = await failedCommandCheck();
    await updateCheckOnTask(tmpDir, boardId, taskId, checkId, { type: 'command', notes: 'tsc -v' });
    const check = (await taskOf(boardId, taskId)).successCriteria!.find((c) => c.id === checkId)!;
    expect(check.status).toBe('failed');
  });
});
