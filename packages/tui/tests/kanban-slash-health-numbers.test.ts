import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBoard, getKanbanQueueHealth, listReadyTasks } from '@wrongstack/kanban';
import { addDependency, addTask } from '@wrongstack/kanban/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHealthReport } from '../src/kanban-slash.js';

/**
 * The plan's end-to-end check for the display authority: the number `/kanban
 * health` prints as claimable must equal what `ready_tasks` hands out on the
 * same board.
 *
 * It did not. The panel printed `counts.ready`, which tallies the stored
 * `status` field — and no production dispatcher writes `status: 'ready'`, so
 * the line read a permanent 0 next to a board with work waiting. This test runs
 * the real slash command against a real board and compares the two.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-slash-health-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

describe('/kanban health', () => {
  it('prints the same claimable count that ready_tasks returns', async () => {
    const board = await createBoard(tmpDir, { title: 'Health numbers' });
    const first = await addTask(tmpDir, board.id, { title: 'Migrate schema' });
    const second = await addTask(tmpDir, board.id, { title: 'Backfill rows' });
    await addTask(tmpDir, board.id, { title: 'Update docs' });
    // One card is blocked behind another, so the answer is not simply "all".
    await addDependency(tmpDir, board.id, second!.task.id, first!.task.id);

    const ready = await listReadyTasks(tmpDir, { boardId: board.id });
    expect(ready).toHaveLength(2);

    const health = await getKanbanQueueHealth(tmpDir, { boardId: board.id });
    const text = renderHealthReport(health);

    expect(text).toMatch(new RegExp(`startable ${ready.length}\\b`));
    // And the old field is not what is being shown: `counts.ready` is 0 here,
    // so a regression to it would print "startable 0" against 2 ready tasks.
    expect(text).not.toMatch(/startable 0\b/);
  });
});
