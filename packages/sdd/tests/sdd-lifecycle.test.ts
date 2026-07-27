import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SddBoardSnapshot } from '../src/board-types.js';
import { SddBoardStore } from '../src/sdd-board-store.js';
import {
  applySddLifecycle,
  cleanupSddWorktrees,
  cleanupStaleSddWorktrees,
  cleanupStaleWorktrees,
  destroySddProject,
  rollbackSddRunFromDisk,
} from '../src/sdd-lifecycle.js';

const worktree = vi.hoisted(() => ({
  cleanupAllManaged: vi.fn(),
  cleanupStale: vi.fn(),
  revertCommits: vi.fn(),
}));

vi.mock('@wrongstack/core/worktree', () => ({
  WorktreeManager: class {
    cleanupAllManaged = worktree.cleanupAllManaged;
    cleanupStale = worktree.cleanupStale;
    revertCommits = worktree.revertCommits;
  },
}));

let tmp: string;

beforeEach(async () => {
  worktree.cleanupAllManaged.mockReset().mockResolvedValue({ removed: 0 });
  worktree.cleanupStale.mockReset().mockResolvedValue({ removed: 0, detected: 0 });
  worktree.revertCommits.mockReset().mockResolvedValue({ ok: true, reverted: 0 });
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-lifecycle-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

function snapshot(over: Partial<SddBoardSnapshot> = {}): SddBoardSnapshot {
  return {
    runId: 'run-1',
    graphId: 'g1',
    title: 'T',
    status: 'idle',
    startedAt: 0,
    updatedAt: 0,
    progress: {
      total: 1,
      completed: 1,
      failed: 0,
      inProgress: 0,
      pending: 0,
      blocked: 0,
      review: 0,
      percentComplete: 100,
    },
    wave: 0,
    tasks: [],
    columns: [],
    ...over,
  };
}

describe('worktree cleanup wrappers', () => {
  it('delegates managed and stale cleanup', async () => {
    worktree.cleanupAllManaged.mockResolvedValueOnce({ removed: 2 });
    worktree.cleanupStale.mockResolvedValueOnce({ removed: 1, detected: 3 });

    await expect(cleanupSddWorktrees(tmp)).resolves.toEqual({ removed: 2 });
    await expect(cleanupStaleWorktrees(tmp)).resolves.toEqual({ removed: 1, detected: 3 });
  });
});

describe('destroySddProject', () => {
  it('deletes specs / task-graphs / boards dirs + the session file', async () => {
    const paths = {
      projectSpecs: path.join(tmp, 'specs'),
      projectTaskGraphs: path.join(tmp, 'task-graphs'),
      projectSddSession: path.join(tmp, 'sdd-session.json'),
      projectSddBoards: path.join(tmp, 'sdd-boards'),
    };
    await fs.mkdir(paths.projectSpecs, { recursive: true });
    await fs.writeFile(path.join(paths.projectSpecs, 's.json'), '{}');
    await fs.mkdir(paths.projectTaskGraphs, { recursive: true });
    await fs.mkdir(paths.projectSddBoards, { recursive: true });
    await fs.writeFile(paths.projectSddSession, '{}');
    // Legacy wizard session (pre-unification path) must also be wiped.
    const legacyWizard = path.join(tmp, 'sdd-wizard-session.json');
    await fs.writeFile(legacyWizard, '{}');

    const res = await destroySddProject({ projectRoot: tmp, paths });

    expect(res.deleted.sort()).toEqual([
      'boards',
      'session',
      'specs',
      'task-graphs',
      'wizard-session',
    ]);
    await expect(fs.access(paths.projectSpecs)).rejects.toBeDefined();
    await expect(fs.access(paths.projectSddSession)).rejects.toBeDefined();
    await expect(fs.access(paths.projectSddBoards)).rejects.toBeDefined();
    await expect(fs.access(legacyWizard)).rejects.toBeDefined();
    // Not a git repo → cleanup removes nothing but never throws.
    expect(res.worktreesRemoved).toBe(0);
  });

  it('skips missing artifacts without throwing', async () => {
    const paths = {
      projectSpecs: path.join(tmp, 'nope-specs'),
      projectTaskGraphs: path.join(tmp, 'nope-graphs'),
      projectSddSession: path.join(tmp, 'nope-session.json'),
      projectSddBoards: path.join(tmp, 'nope-boards'),
    };
    const res = await destroySddProject({ projectRoot: tmp, paths });
    // Missing dirs are removed idempotently (rm force) but the file unlink fails.
    expect(res.deleted).not.toContain('session');
  });

  it('keeps destroying when worktree cleanup and artifact removal fail', async () => {
    worktree.cleanupAllManaged.mockRejectedValueOnce(new Error('cleanup failed'));
    const invalid = `${String.fromCharCode(0)}invalid`;
    const res = await destroySddProject({
      projectRoot: tmp,
      paths: {
        projectSpecs: invalid,
        projectTaskGraphs: invalid,
        projectSddSession: invalid,
        projectSddBoards: invalid,
      },
    });

    expect(res.worktreesRemoved).toBe(0);
    expect(res.deleted).toEqual([]);
  });
});

describe('rollbackSddRunFromDisk', () => {
  const boardsDir = () => path.join(tmp, 'sdd-boards');

  it('reports when there is no board to roll back', async () => {
    const res = await rollbackSddRunFromDisk({ projectRoot: tmp, boardsDir: boardsDir() });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no SDD board/i);
  });

  it('reports when an explicitly requested board does not exist', async () => {
    const res = await rollbackSddRunFromDisk({
      projectRoot: tmp,
      boardsDir: boardsDir(),
      runId: 'missing',
    });
    expect(res.reason).toBe('board "missing" not found');
  });

  it('reports when the run recorded no merged commits', async () => {
    const store = new SddBoardStore({ baseDir: boardsDir() });
    await store.saveSnapshot(snapshot({ baseBranch: 'main', mergedCommits: [] }));
    const res = await rollbackSddRunFromDisk({ projectRoot: tmp, boardsDir: boardsDir() });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no merged commits/i);
  });

  it('treats an omitted merged commit list as empty', async () => {
    const store = new SddBoardStore({ baseDir: boardsDir() });
    await store.saveSnapshot(snapshot({ baseBranch: 'main' }));
    const res = await rollbackSddRunFromDisk({ projectRoot: tmp, boardsDir: boardsDir() });
    expect(res.reason).toMatch(/no merged commits/i);
  });

  it('reports when the run recorded no base branch', async () => {
    const store = new SddBoardStore({ baseDir: boardsDir() });
    await store.saveSnapshot(
      snapshot({ mergedCommits: [{ taskId: 't', sha: 'abc', title: 'x' }] }),
    );
    const res = await rollbackSddRunFromDisk({ projectRoot: tmp, boardsDir: boardsDir() });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/base branch/i);
  });

  it('delegates recorded commits to the worktree manager', async () => {
    const store = new SddBoardStore({ baseDir: boardsDir() });
    await store.saveSnapshot(
      snapshot({
        baseBranch: 'main',
        mergedCommits: [
          { taskId: 't1', sha: 'abc', title: 'one' },
          { taskId: 't2', sha: 'def', title: 'two' },
        ],
      }),
    );
    worktree.revertCommits.mockResolvedValueOnce({ ok: true, reverted: 2 });

    await expect(
      rollbackSddRunFromDisk({ projectRoot: tmp, boardsDir: boardsDir() }),
    ).resolves.toEqual({ ok: true, reverted: 2 });
    expect(worktree.revertCommits).toHaveBeenCalledWith('main', ['abc', 'def']);
  });
});

describe('destroySddProject with revertMerged', () => {
  function destroyPaths() {
    return {
      projectSpecs: path.join(tmp, 'specs'),
      projectTaskGraphs: path.join(tmp, 'task-graphs'),
      projectSddSession: path.join(tmp, 'sdd-session.json'),
      projectSddBoards: path.join(tmp, 'sdd-boards'),
    };
  }

  it('surfaces a refused revert but still wipes the artifacts', async () => {
    const paths = destroyPaths();
    await fs.mkdir(paths.projectSpecs, { recursive: true });
    await fs.writeFile(paths.projectSddSession, '{}');
    // No board recorded → the revert can find nothing, but destroy proceeds.
    const res = await destroySddProject({ projectRoot: tmp, paths, revertMerged: true });

    expect(res.revertOk).toBe(false);
    expect(res.revertReason).toMatch(/no SDD board/i);
    expect(res.reverted).toBe(0);
    expect(res.deleted).toContain('specs');
    expect(res.deleted).toContain('session');
  });

  it('leaves revert fields untouched when not requested', async () => {
    const res = await destroySddProject({ projectRoot: tmp, paths: destroyPaths() });
    expect(res.reverted).toBe(0);
    expect(res.revertOk).toBeUndefined();
  });

  it('converts a rejected revert into a partial destroy result', async () => {
    const paths = destroyPaths();
    const store = new SddBoardStore({ baseDir: paths.projectSddBoards });
    await store.saveSnapshot(
      snapshot({
        baseBranch: 'main',
        mergedCommits: [{ taskId: 't', sha: 'abc', title: 'one' }],
      }),
    );
    worktree.revertCommits.mockRejectedValueOnce(new Error('revert exploded'));

    const res = await destroySddProject({ projectRoot: tmp, paths, revertMerged: true });

    expect(res.revertOk).toBe(false);
    expect(res.revertReason).toBe('revert exploded');
  });
});

describe('applySddLifecycle', () => {
  function lcPaths() {
    return {
      projectSpecs: path.join(tmp, 'specs'),
      projectTaskGraphs: path.join(tmp, 'task-graphs'),
      projectSddSession: path.join(tmp, 'sdd-session.json'),
      projectSddBoards: path.join(tmp, 'sdd-boards'),
    };
  }

  it('cleanup_worktrees → ok with a removed count (0 outside a repo)', async () => {
    const res = await applySddLifecycle('cleanup_worktrees', {
      projectRoot: tmp,
      paths: lcPaths(),
    });
    expect(res).toMatchObject({ op: 'cleanup_worktrees', ok: true, removed: 0 });
  });

  it('rollback → ok:false with a reason when there is no board', async () => {
    const res = await applySddLifecycle('rollback', { projectRoot: tmp, paths: lcPaths() });
    expect(res.op).toBe('rollback');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no SDD board/i);
  });

  it('destroy → ok:true and reports deleted artifacts', async () => {
    const paths = lcPaths();
    await fs.mkdir(paths.projectSpecs, { recursive: true });
    await fs.writeFile(paths.projectSddSession, '{}');
    const res = await applySddLifecycle('destroy', { projectRoot: tmp, paths });
    expect(res.op).toBe('destroy');
    expect(res.ok).toBe(true);
    expect(res.deleted).toContain('specs');
  });

  it('surfaces a refused destroy revert through the uniform result', async () => {
    const res = await applySddLifecycle('destroy', {
      projectRoot: tmp,
      paths: lcPaths(),
      revertMerged: true,
    });

    expect(res.ok).toBe(true);
    expect(res.reason).toMatch(/no SDD board/i);
  });

  it('returns a uniform failure when an operation rejects', async () => {
    worktree.cleanupAllManaged.mockRejectedValueOnce(new Error('operation failed'));
    const res = await applySddLifecycle('cleanup_worktrees', {
      projectRoot: tmp,
      paths: lcPaths(),
    });

    expect(res).toEqual({
      op: 'cleanup_worktrees',
      ok: false,
      reason: 'operation failed',
    });
  });
});

describe('cleanupStaleSddWorktrees — liveness guard', () => {
  const boardsDir = () => path.join(tmp, 'sdd-boards');
  const NOW = 10_000_000;

  async function saveBoard(status: SddBoardSnapshot['status'], updatedAt: number) {
    const store = new SddBoardStore({ baseDir: boardsDir() });
    await store.saveSnapshot(snapshot({ status, updatedAt }));
  }

  it('skips while a running board is fresh (run appears live)', async () => {
    await saveBoard('running', NOW - 5_000); // 5s old
    const res = await cleanupStaleSddWorktrees({
      projectRoot: tmp,
      boardsDir: boardsDir(),
      now: () => NOW,
    });
    expect(res.swept).toBe(false);
    expect(res.skippedReason).toMatch(/live/i);
  });

  it('skips while a paused board is within the paused window', async () => {
    await saveBoard('paused', NOW - 60_000); // 1min old, < 30min default
    const res = await cleanupStaleSddWorktrees({
      projectRoot: tmp,
      boardsDir: boardsDir(),
      now: () => NOW,
    });
    expect(res.swept).toBe(false);
    expect(res.skippedReason).toMatch(/paused/i);
  });

  it('proceeds when a running board is stale (crash → no recent update)', async () => {
    await saveBoard('running', NOW - 5 * 60_000); // 5min old, > 2min default
    const res = await cleanupStaleSddWorktrees({
      projectRoot: tmp,
      boardsDir: boardsDir(),
      now: () => NOW,
    });
    // tmp is not a git repo → nothing to sweep, but the guard did NOT skip.
    expect(res.skippedReason).toBeUndefined();
  });

  it('proceeds for a finished board and when no board exists', async () => {
    const none = await cleanupStaleSddWorktrees({
      projectRoot: tmp,
      boardsDir: boardsDir(),
      now: () => NOW,
    });
    expect(none.skippedReason).toBeUndefined();

    await saveBoard('completed', NOW - 1_000);
    const done = await cleanupStaleSddWorktrees({
      projectRoot: tmp,
      boardsDir: boardsDir(),
      now: () => NOW,
    });
    expect(done.skippedReason).toBeUndefined();
  });

  it('reports a sweep and tolerates stale cleanup failures', async () => {
    worktree.cleanupStale.mockResolvedValueOnce({ removed: 2, detected: 3 });
    await expect(
      cleanupStaleSddWorktrees({ projectRoot: tmp, boardsDir: boardsDir() }),
    ).resolves.toMatchObject({ swept: true, removed: 2, detected: 3 });

    worktree.cleanupStale.mockRejectedValueOnce(new Error('stale cleanup failed'));
    await expect(
      cleanupStaleSddWorktrees({ projectRoot: tmp, boardsDir: boardsDir() }),
    ).resolves.toEqual({ swept: false, removed: 0, detected: 0 });
  });

  it('honors custom liveness windows', async () => {
    await saveBoard('running', NOW - 10);
    const running = await cleanupStaleSddWorktrees({
      projectRoot: tmp,
      boardsDir: boardsDir(),
      now: () => NOW,
      runningLiveMs: 20,
    });
    expect(running.skippedReason).toMatch(/live/i);

    await saveBoard('paused', NOW - 10);
    const paused = await cleanupStaleSddWorktrees({
      projectRoot: tmp,
      boardsDir: boardsDir(),
      now: () => NOW,
      pausedLiveMs: 20,
    });
    expect(paused.skippedReason).toMatch(/paused/i);
  });
});
