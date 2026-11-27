/**
 * Durable project-wide Kanban Companion policy (`companion-policy.ts`).
 *
 * Contract under test:
 *   - `getKanbanCompanionEnabled` defaults to true; `setKanbanCompanionEnabled`
 *     validates its boolean and round-trips durably (durability across daemon
 *     restarts is proven over real IPC in `tests/server/companion-policy-ipc.test.ts`).
 *   - A disabled policy refuses claims/renewals/reviews/finishes (plain
 *     `false`/`null`, matching the existing "no lease" signals) and fences the
 *     active manager lease via a monotonic epoch that survives re-enable.
 *   - Enabling is idempotent: it never fences a freshly claimed manager.
 *   - Review history survives disable/re-enable; deterministic and manual
 *     board behavior is unchanged.
 *   - Concurrent policy sets serialize in the owner critical section; the
 *     epoch never regresses and a claim racing a disable is always fenced.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { managementTaskVersion } from '../src/management-fence.js';
import {
  getKanbanCompanionEnabled,
  KANBAN_COMPANION_METADATA_KEY,
  readKanbanCompanionPolicy,
  setKanbanCompanionEnabled,
} from '../src/manager/companion-policy.js';
import {
  claimBoardManagement,
  finishBoardManagement,
  recordTaskManagementReview,
  renewBoardManagement,
} from '../src/manager/management.js';
import { mutateBoard, readKanbanMetadata } from '../src/storage.js';
import type { KanbanBoard, KanbanEventContext } from '../src/types.js';
import {
  addNoteToTask,
  addTask,
  createBoard,
  getBoard,
  updateBoard,
} from './helpers/session-manager.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `kanban-companion-${label}-`));
  roots.push(root);
  return root;
}

function managerFence(board: KanbanBoard, taskId: string, token: string): KanbanEventContext {
  const task = board.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`fixture task ${taskId} missing`);
  return {
    sessionId: '2026-08-26/sess_01TESTKANBAN0000000000000',
    expectedManagementToken: token,
    expectedManagementTaskVersions: {
      [taskId]: managementTaskVersion(board, task),
    },
  };
}

describe('durable Kanban companion policy', () => {
  it('defaults to enabled, round-trips, and idempotent enable never fences a fresh claim', async () => {
    const root = await tempRoot('roundtrip');
    expect(await getKanbanCompanionEnabled(root)).toBe(true);
    expect(await setKanbanCompanionEnabled(root, false)).toBe(false);
    expect(await getKanbanCompanionEnabled(root)).toBe(false);
    expect(await setKanbanCompanionEnabled(root, true)).toBe(true);
    expect(await setKanbanCompanionEnabled(root, true)).toBe(true);

    const board = await createBoard(root, { title: 'Work' });
    await addTask(root, board.id, { title: 'Card' });
    expect(
      await claimBoardManagement(root, board.id, { token: 'm1', fingerprint: 'f1', cooldownMs: 0 }),
    ).toBe(true);
    // Repeated enables must not fence the freshly claimed manager.
    await Promise.all([
      setKanbanCompanionEnabled(root, true),
      setKanbanCompanionEnabled(root, true),
    ]);
    expect(await renewBoardManagement(root, board.id, 'm1')).toBe(true);
  });

  it('rejects non-boolean policy values without touching state', async () => {
    const root = await tempRoot('validation');
    for (const bad of ['false', 'true', 1, 0, null, undefined, { enabled: true }]) {
      await expect(setKanbanCompanionEnabled(root, bad as unknown as boolean)).rejects.toThrow(
        TypeError,
      );
    }
    expect(await getKanbanCompanionEnabled(root)).toBe(true);
    expect(await readKanbanMetadata(root, KANBAN_COMPANION_METADATA_KEY)).toBeNull();
  });

  it('refuses claims, renewals, finishes and reviews while disabled, and keeps stale tokens fenced after re-enable', async () => {
    const root = await tempRoot('refusals');
    const board = await createBoard(root, { title: 'Work' });
    const created = await addTask(root, board.id, { title: 'Card' });
    expect(
      await claimBoardManagement(root, board.id, {
        token: 'm1',
        fingerprint: 'fp-1',
        cooldownMs: 0,
      }),
    ).toBe(true);
    expect(await renewBoardManagement(root, board.id, 'm1')).toBe(true);

    expect(await setKanbanCompanionEnabled(root, false)).toBe(false);
    expect(
      await claimBoardManagement(root, board.id, {
        token: 'm2',
        fingerprint: 'fp-2',
        cooldownMs: 0,
      }),
    ).toBe(false);
    expect(await renewBoardManagement(root, board.id, 'm1')).toBe(false);
    expect(
      await finishBoardManagement(root, board.id, 'm1', {
        status: 'completed',
        result: 'late receipt',
      }),
    ).toBe(false);
    // Disabled policy refuses the write softly: like every other refused
    // review this resolves to `null`, not an error.
    expect(
      await recordTaskManagementReview(
        root,
        board.id,
        created!.task.id,
        { disposition: 'adequate', reason: 'late review' },
        {
          sessionId: '2026-08-26/sess_01TESTKANBAN0000000000000',
          expectedManagementToken: 'm1',
        },
      ),
    ).toBeNull();

    const fenced = await getBoard(root, board.id);
    expect(fenced?.management?.lease).toBeUndefined();
    expect(fenced?.management?.status).toBe('failed');
    expect(fenced?.management?.error).toContain('companion');

    // Re-enable: the fenced worker still cannot resume its epoch-0 lease.
    await setKanbanCompanionEnabled(root, true);
    expect(await renewBoardManagement(root, board.id, 'm1')).toBe(false);
    expect(await finishBoardManagement(root, board.id, 'm1', { status: 'completed' })).toBe(false);
    const live = (await getBoard(root, board.id))!;
    await expect(
      recordTaskManagementReview(
        root,
        board.id,
        created!.task.id,
        { disposition: 'adequate', reason: 'stale review' },
        managerFence(live, created!.task.id, 'm1'),
      ),
    ).rejects.toThrow('management lease expired or changed');

    // A fresh claim works and is stamped with the current epoch.
    expect(
      await claimBoardManagement(root, board.id, {
        token: 'm2',
        fingerprint: 'fp-2',
        cooldownMs: 0,
      }),
    ).toBe(true);
    const claimed = await getBoard(root, board.id);
    expect(claimed?.management?.lease?.token).toBe('m2');
    expect(claimed?.management?.lease?.companionEpoch).toBe(1);
  });

  it('overrides a leftover live lease from a crashed disable and fences its writes by epoch', async () => {
    const root = await tempRoot('crash-recovery');
    const board = await createBoard(root, { title: 'Work' });
    const created = await addTask(root, board.id, { title: 'Card' });
    expect(
      await claimBoardManagement(root, board.id, {
        token: 'm1',
        fingerprint: 'fp-1',
        cooldownMs: 0,
      }),
    ).toBe(true);
    await setKanbanCompanionEnabled(root, false);
    await setKanbanCompanionEnabled(root, true);

    // Simulate a disable whose projection crashed before reaching this board:
    // a live lease stamped with the pre-disable epoch survives on disk.
    await mutateBoard(root, board.id, (current) => {
      current.management = {
        status: 'running',
        lease: {
          token: 'ghost',
          fingerprint: 'fp-ghost',
          expiresAt: Date.now() + 60_000,
          companionEpoch: 0,
        },
      };
    });

    const live = (await getBoard(root, board.id))!;
    // Token-driven writes refuse on the epoch mismatch (write fence).
    await expect(
      addNoteToTask(
        root,
        board.id,
        created!.task.id,
        { author: 'kanban-manager', content: 'stale write' },
        managerFence(live, created!.task.id, 'ghost'),
      ),
    ).rejects.toThrow('companion policy');
    // Resume paths refuse on the metadata epoch even after re-enable.
    expect(await renewBoardManagement(root, board.id, 'ghost')).toBe(false);
    expect(await finishBoardManagement(root, board.id, 'ghost', { status: 'completed' })).toBe(
      false,
    );
    // A fresh claim overrides the dead-but-unexpired lease instead of waiting.
    expect(
      await claimBoardManagement(root, board.id, {
        token: 'm3',
        fingerprint: 'fp-3',
        cooldownMs: 0,
      }),
    ).toBe(true);
    expect((await getBoard(root, board.id))?.management?.lease?.token).toBe('m3');
  });

  it('promotes uncommitted lease reviews and retains committed review history across disable/re-enable', async () => {
    const root = await tempRoot('history');
    const board = await createBoard(root, { title: 'Work' });
    const created = await addTask(root, board.id, { title: 'Card' });
    expect(
      await claimBoardManagement(root, board.id, {
        token: 'm1',
        fingerprint: 'fp-1',
        cooldownMs: 0,
      }),
    ).toBe(true);
    const read = (await getBoard(root, board.id))!;
    expect(
      await recordTaskManagementReview(
        root,
        board.id,
        created!.task.id,
        { disposition: 'adequate', reason: 'Reviewed and adequate.' },
        managerFence(read, created!.task.id, 'm1'),
      ),
    ).not.toBeNull();

    // Disable mid-run: the uncommitted lease review is promoted, not dropped.
    await setKanbanCompanionEnabled(root, false);
    const fenced = await getBoard(root, board.id);
    expect(fenced?.management?.lease).toBeUndefined();
    expect(fenced?.management?.reviews?.[created!.task.id]).toMatchObject({
      disposition: 'adequate',
    });

    // A finished run's committed history is untouched by policy changes.
    await setKanbanCompanionEnabled(root, true);
    expect(
      await claimBoardManagement(root, board.id, {
        token: 'm2',
        fingerprint: 'fp-2',
        cooldownMs: 0,
      }),
    ).toBe(true);
    const reread = (await getBoard(root, board.id))!;
    expect(
      await recordTaskManagementReview(
        root,
        board.id,
        created!.task.id,
        { disposition: 'adequate', reason: 'Re-reviewed after re-enable.' },
        managerFence(reread, created!.task.id, 'm2'),
      ),
    ).not.toBeNull();
    expect(
      await finishBoardManagement(root, board.id, 'm2', {
        status: 'completed',
        result: 'Reviewed 1 active card.',
      }),
    ).toBe(true);
    await setKanbanCompanionEnabled(root, false);
    await setKanbanCompanionEnabled(root, true);
    const stored = await getBoard(root, board.id);
    expect(stored?.management?.status).toBe('completed');
    expect(stored?.management?.reviews?.[created!.task.id]).toMatchObject({
      disposition: 'adequate',
      reason: 'Re-reviewed after re-enable.',
    });
    expect(stored?.management?.reviewedFingerprint).toBe('fp-2');
    expect(stored?.management?.summary).toContain('Reviewed');
  });

  it('leaves deterministic boards and manual token-less edits unchanged', async () => {
    const root = await tempRoot('deterministic');
    const board = await createBoard(root, {
      title: 'Manual',
      supervisor: { enabled: false, mode: 'deterministic' },
    });
    const created = await addTask(root, board.id, { title: 'Card' });
    const claimInput = { token: 'm1', fingerprint: 'fp-1', cooldownMs: 0 };
    expect(await claimBoardManagement(root, board.id, claimInput)).toBe(false);
    await setKanbanCompanionEnabled(root, false);
    expect(await claimBoardManagement(root, board.id, claimInput)).toBe(false);
    // Manual token-less behavior is identical while the companion is disabled.
    await addNoteToTask(root, board.id, created!.task.id, {
      author: 'operator',
      content: 'manual note',
    });
    await updateBoard(root, board.id, { title: 'Renamed while companion disabled' });
    const stored = await getBoard(root, board.id);
    expect(stored?.title).toBe('Renamed while companion disabled');
    expect(stored?.tasks[0]?.notes).toHaveLength(1);
  });

  it('serializes concurrent sets, never regresses the epoch, and fences a claim racing a disable', async () => {
    const root = await tempRoot('concurrency');
    const board = await createBoard(root, { title: 'Race' });
    await addTask(root, board.id, { title: 'Card' });
    expect(
      await claimBoardManagement(root, board.id, {
        token: 'early',
        fingerprint: 'fp-early',
        cooldownMs: 0,
      }),
    ).toBe(true);

    // Interleaved sets serialize in the owner critical section.
    const outcomes = await Promise.all([
      setKanbanCompanionEnabled(root, false),
      setKanbanCompanionEnabled(root, true),
      setKanbanCompanionEnabled(root, false),
    ]);
    expect(outcomes).toEqual([false, true, false]);
    expect(await readKanbanCompanionPolicy(root)).toEqual({ enabled: false, epoch: 2 });

    await setKanbanCompanionEnabled(root, true);
    // The epoch-0 manager stays fenced even after re-enable.
    expect(await renewBoardManagement(root, board.id, 'early')).toBe(false);
    expect(await finishBoardManagement(root, board.id, 'early', { status: 'completed' })).toBe(
      false,
    );

    // A claim racing a disable always ends fenced: either the claim observes
    // the disabled policy and refuses, or it claims and is immediately
    // epoch-fenced by the disable that follows.
    const [racerClaimed] = await Promise.all([
      claimBoardManagement(root, board.id, {
        token: 'racer',
        fingerprint: 'fp-racer',
        cooldownMs: 0,
      }),
      setKanbanCompanionEnabled(root, false),
    ]);
    expect(await readKanbanCompanionPolicy(root)).toEqual({ enabled: false, epoch: 3 });
    expect(await renewBoardManagement(root, board.id, 'racer')).toBe(false);
    void racerClaimed;

    // Idempotent enables neither regress the epoch nor fence a fresh claim.
    await setKanbanCompanionEnabled(root, true);
    const before = await readKanbanCompanionPolicy(root);
    await Promise.all([
      setKanbanCompanionEnabled(root, true),
      setKanbanCompanionEnabled(root, true),
    ]);
    expect(await readKanbanCompanionPolicy(root)).toEqual(before);
    expect(
      await claimBoardManagement(root, board.id, {
        token: 'fresh',
        fingerprint: 'fp-fresh',
        cooldownMs: 0,
      }),
    ).toBe(true);
    expect(await renewBoardManagement(root, board.id, 'fresh')).toBe(true);
  });
});
