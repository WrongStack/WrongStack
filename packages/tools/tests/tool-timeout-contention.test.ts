/**
 * Regression test: todo and task tools must return within their timeout
 * budget even when the kanban mirror's file lock is held by another agent.
 *
 * Before commit 51ad502b8, both tools synchronously awaited the kanban
 * projection (projectSession*ToKanban), which blocked on withFileLock.
 * Under multi-agent contention the lock wait consumed the entire timeout
 * budget and the executor killed the tool with TOOL_TIMEOUT.
 *
 * The fix switched to fire-and-forget mirrorSession*ToKanban wrappers
 * (queueLatestMirror). This test holds a kanban board lock and verifies
 * the tools still return promptly with correct state.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createBoard } from '@wrongstack/kanban';
import { getKanbanPath } from '@wrongstack/kanban/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskTool } from '../src/task.js';
import { todoTool } from '../src/todo.js';
import { mkSandbox, newSignal, type Sandbox } from './fixtures.js';

/** Generous ceiling — the tools should return in single-digit ms. */
const BUDGET_MS = 2_000;

describe('tool timeout under kanban lock contention', () => {
  let sb: Sandbox;
  let lockPath: string | undefined;

  beforeEach(async () => {
    // Enable mirroring so the tools actually attempt kanban projection
    delete process.env.WRONGSTACK_KANBAN_TASK_MIRROR;
    sb = await mkSandbox();
  });

  afterEach(async () => {
    // Release the lock before cleanup to avoid ENOTEMPTY races on Windows
    if (lockPath) {
      await fs.unlink(lockPath).catch(() => undefined);
      lockPath = undefined;
    }
    // Let the fire-and-forget mirror settle before rm -rf
    await new Promise((r) => setTimeout(r, 200));
    process.env.WRONGSTACK_KANBAN_TASK_MIRROR = '0';
    await sb.cleanup();
  });

  /**
   * Create a session board tagged for this sandbox's session, then hold
   * its file lock to simulate another agent mid-write. The mirror will
   * find the board via listBoards → tag match, then block on
   * withFileLock when syncBoardFromTaskGraph tries to mutate it.
   */
  async function holdBoardLock(): Promise<void> {
    const sessionId = sb.ctx.session?.id ?? 'test';
    const board = await createBoard(sb.dir, {
      title: `Session ${sessionId}`,
      tags: ['session', 'session-work', `session:${sessionId}`],
    });
    const boardPath = getKanbanPath(sb.dir, board.id);
    lockPath = path.join(path.dirname(boardPath), `.${path.basename(boardPath)}.lock`);
    // Create the lock exclusively — same mechanism withFileLock uses
    await fs.writeFile(lockPath, `${process.pid}:${Date.now()}`, { flag: 'wx' });
  }

  it('todo returns within budget while kanban board lock is held', async () => {
    await holdBoardLock();

    const t0 = performance.now();
    const out = await todoTool.execute(
      { todos: [{ id: '1', content: 'contended', status: 'in_progress' }] },
      sb.ctx,
      { signal: newSignal() },
    );
    const elapsed = performance.now() - t0;

    expect(out.count).toBe(1);
    expect(out.in_progress).toBe(1);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('task returns within budget while kanban board lock is held', async () => {
    const taskPath = path.join(sb.dir, 'sess.tasks.json');
    (sb.ctx.meta as Record<string, unknown>)['task.path'] = taskPath;
    await holdBoardLock();

    const t0 = performance.now();
    const out = await taskTool.execute(
      {
        action: 'replace',
        tasks: [
          {
            id: 't1',
            title: 'contended',
            type: 'feature',
            priority: 'medium',
            status: 'pending',
            createdAt: '2026-07-27T00:00:00Z',
            updatedAt: '2026-07-27T00:00:00Z',
          },
        ],
      },
      sb.ctx,
      { signal: newSignal() },
    );
    const elapsed = performance.now() - t0;

    expect(out.ok).toBe(true);
    expect(out.count).toBe(1);
    expect(elapsed).toBeLessThan(BUDGET_MS);

    // Core state mutation still happened despite the contended mirror
    const onDisk = JSON.parse(await fs.readFile(taskPath, 'utf8')) as {
      tasks: Array<{ id: string; status: string }>;
    };
    expect(onDisk.tasks).toHaveLength(1);
    expect(onDisk.tasks[0]?.id).toBe('t1');
  });
});
