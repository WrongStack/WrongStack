/**
 * A verification run must not consume the criterion it verified.
 *
 * `check.notes` is the criterion's INPUT: every deterministic plugin reads it
 * as the command, test pattern, path, or JSON config to execute, falling back
 * to `description` only when it is empty. The write-back in
 * `verifyTaskCompletion` used to overwrite it with a result narrative
 * (`[failed] File not found: evidence.txt`), which made every executable
 * criterion single-use — the second run read the narrative as its input and
 * could never pass, so a defect that had since been fixed could not be
 * re-verified.
 *
 * The outcome was never lost by removing that write: it lives in
 * `verificationReport.checks[]` (status, evidence, error), which is persisted
 * with the task. Nothing renders `notes`.
 *
 * This test was written after the round-trip surfaced the bug: it only became
 * reachable once the `kanban` tool could author a non-`manual` criterion.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyTaskCompletion } from '../helpers/session-manager.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seed() {
  const root = await mkdtemp(join(tmpdir(), 'wstack-criterion-input-'));
  roots.push(root);
  const { createBoard, addTask, addCheckToTask, getBoard } = await import(
    '../helpers/session-manager.js'
  );
  const board = await createBoard(root, { title: 'Re-verification board' });
  const added = await addTask(root, board.id, { title: 'Card' });
  if (!added) throw new Error('Failed to add task');
  await addCheckToTask(root, board.id, added.task.id, {
    description: 'The marker file exists',
    type: 'file_exists',
    notes: 'evidence.txt',
  });
  const criterion = async () =>
    (await getBoard(root, board.id))?.tasks.find((t) => t.id === added.task.id)
      ?.successCriteria?.[0];
  return { root, boardId: board.id, taskId: added.task.id, criterion };
}

describe('verifyTaskCompletion — criterion input survives the run', () => {
  it('keeps notes intact after a failing run', async () => {
    const { root, boardId, taskId, criterion } = await seed();
    const result = await verifyTaskCompletion(root, boardId, taskId);

    expect(result.report.checks[0]?.status).toBe('failed');
    // The verifier reported the failure; it did not eat the path.
    expect(result.task.successCriteria?.[0]?.notes).toBe('evidence.txt');
    expect(result.task.successCriteria?.[0]?.status).toBe('failed');
    void criterion;
  });

  it('re-verifies to passed once the world satisfies the criterion', async () => {
    const { root, boardId, taskId } = await seed();

    const failing = await verifyTaskCompletion(root, boardId, taskId);
    expect(failing.report.checks[0]?.status).toBe('failed');

    // Nothing about the card changes — only the filesystem does.
    await writeFile(join(root, 'evidence.txt'), 'done');

    const passing = await verifyTaskCompletion(root, boardId, taskId);
    expect(passing.report.checks[0]?.status).toBe('passed');
    expect(passing.task.successCriteria?.[0]?.status).toBe('passed');
    expect(passing.task.successCriteria?.[0]?.notes).toBe('evidence.txt');
  });

  it('still records who verified and when', async () => {
    // Removing the notes write must not remove the audit fields beside it.
    const { root, boardId, taskId } = await seed();
    await writeFile(join(root, 'evidence.txt'), 'done');
    const result = await verifyTaskCompletion(root, boardId, taskId);
    expect(result.task.successCriteria?.[0]?.checkedBy).toBe('system');
    expect(result.task.successCriteria?.[0]?.checkedAt).toBeTruthy();
  });
});
