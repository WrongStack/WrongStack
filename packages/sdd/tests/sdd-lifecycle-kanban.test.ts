/**
 * Kanban-transport coverage for sdd-lifecycle.ts. The sibling suite
 * (sdd-lifecycle.test.ts) exercises the legacy-file transport against a real
 * SddBoardStore; here `@wrongstack/kanban` is mocked so the workflow-state
 * branches (list / load / migrate / destroy-time cleanup) run in isolation.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SddBoardSnapshot } from '../src/board-types.js';
import { SddBoardStore } from '../src/sdd-board-store.js';

const kanban = vi.hoisted(() => ({
  listStates: vi.fn(),
  readState: vi.fn(),
  writeState: vi.fn(),
  deleteState: vi.fn(),
  listBoards: vi.fn(),
  removeBoard: vi.fn(),
}));

vi.mock('@wrongstack/kanban', () => ({
  kanbanWorkflowId: (kind: string, name: string) => `${kind}:${name}`,
  listKanbanWorkflowStates: (...args: unknown[]) => kanban.listStates(...args),
  readKanbanWorkflowState: (...args: unknown[]) => kanban.readState(...args),
  writeKanbanWorkflowState: (...args: unknown[]) => kanban.writeState(...args),
  deleteKanbanWorkflowState: (...args: unknown[]) => kanban.deleteState(...args),
  listBoards: (...args: unknown[]) => kanban.listBoards(...args),
  removeBoard: (...args: unknown[]) => kanban.removeBoard(...args),
}));

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

import {
  cleanupStaleSddWorktrees,
  destroySddProject,
  rollbackSddRunFromDisk,
} from '../src/sdd-lifecycle.js';

let tmp: string;

beforeEach(async () => {
  for (const mock of Object.values(kanban)) mock.mockReset();
  kanban.listStates.mockResolvedValue([]);
  kanban.readState.mockResolvedValue(null);
  kanban.writeState.mockImplementation(async (_root, _id, value) => ({ revision: 1, value }));
  kanban.deleteState.mockResolvedValue(true);
  kanban.listBoards.mockResolvedValue([]);
  kanban.removeBoard.mockResolvedValue(true);
  worktree.cleanupAllManaged.mockReset().mockResolvedValue({ removed: 0 });
  worktree.cleanupStale.mockReset().mockResolvedValue({ removed: 0, detected: 0 });
  worktree.revertCommits.mockReset().mockResolvedValue({ ok: true, reverted: 0 });
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-lifecycle-kanban-'));
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
      estimatedHours: 0,
      actualHours: 0,
    },
    wave: 0,
    tasks: [],
    columns: [],
    baseBranch: 'main',
    mergedCommits: [{ taskId: 't', sha: 'abc', title: 'one' }],
    ...over,
  };
}

const boardsDir = () => path.join(tmp, 'sdd-boards');

describe('listSddSnapshots — kanban transport', () => {
  it('returns kanban snapshots newest-first and skips non-snapshot values', async () => {
    const older = snapshot({ runId: 'run-old', updatedAt: 10 });
    const newer = snapshot({
      runId: 'run-new',
      updatedAt: 20,
      mergedCommits: [{ taskId: 't2', sha: 'def', title: 'two' }],
    });
    kanban.listStates.mockResolvedValue([
      { workflowId: 'sdd:run-old', revision: 1, value: older },
      { workflowId: 'sdd:run-new', revision: 1, value: newer },
      { workflowId: 'sdd:null', revision: 1, value: null },
      { workflowId: 'sdd:junk', revision: 1, value: 'not-a-snapshot' },
    ]);

    const res = await rollbackSddRunFromDisk({
      projectRoot: tmp,
      boardsDir: boardsDir(),
      stateTransport: 'kanban',
    });

    // No runId → the most recently updated (kanban) board wins.
    expect(res).toEqual({ ok: true, reverted: 0 });
    expect(worktree.revertCommits).toHaveBeenCalledWith('main', ['def']);
  });

  it('migrates legacy snapshots into kanban workflow state when kanban is empty', async () => {
    const store = new SddBoardStore({ baseDir: boardsDir() });
    await store.saveSnapshot(snapshot({ runId: 'run-a', updatedAt: 5 }));
    await store.saveSnapshot(snapshot({ runId: 'run-b', updatedAt: 9 }));
    // A listed-but-unreadable entry is skipped by loadLegacySnapshots.
    await store.saveSnapshot(snapshot({ runId: 'run-corrupt', updatedAt: 7 }));
    await fs.writeFile(store.snapshotPath('run-corrupt'), '{ not json');

    const res = await rollbackSddRunFromDisk({
      projectRoot: tmp,
      boardsDir: boardsDir(),
      stateTransport: 'kanban',
    });

    expect(res.ok).toBe(true);
    // Latest readable legacy board (run-b) drives the rollback…
    expect(worktree.revertCommits).toHaveBeenCalledWith('main', ['abc']);
    // …and every readable legacy snapshot is imported into kanban state.
    expect(kanban.writeState).toHaveBeenCalledTimes(2);
    expect(kanban.writeState).toHaveBeenCalledWith(tmp, 'sdd:run-a', expect.any(Object));
    expect(kanban.writeState).toHaveBeenCalledWith(tmp, 'sdd:run-b', expect.any(Object));
  });
});

describe('loadSddSnapshot — kanban transport', () => {
  it('reads a board that only exists as kanban workflow state', async () => {
    const snap = snapshot({ runId: 'run-x' });
    kanban.readState.mockResolvedValue({ workflowId: 'sdd:run-x', revision: 3, value: snap });

    const res = await rollbackSddRunFromDisk({
      projectRoot: tmp,
      boardsDir: boardsDir(),
      runId: 'run-x',
      stateTransport: 'kanban',
    });

    expect(res).toEqual({ ok: true, reverted: 0 });
    expect(worktree.revertCommits).toHaveBeenCalledWith('main', ['abc']);
  });

  it('migrates a legacy-only board into kanban workflow state on read', async () => {
    const store = new SddBoardStore({ baseDir: boardsDir() });
    await store.saveSnapshot(snapshot({ runId: 'run-legacy' }));

    const res = await rollbackSddRunFromDisk({
      projectRoot: tmp,
      boardsDir: boardsDir(),
      runId: 'run-legacy',
      stateTransport: 'kanban',
    });

    expect(res.ok).toBe(true);
    expect(kanban.writeState).toHaveBeenCalledWith(tmp, 'sdd:run-legacy', expect.any(Object));
  });

  it('reports when the board exists in neither kanban nor legacy storage', async () => {
    kanban.readState.mockResolvedValue({ workflowId: 'sdd:run-x', revision: 1, value: {} });

    const res = await rollbackSddRunFromDisk({
      projectRoot: tmp,
      boardsDir: boardsDir(),
      runId: 'run-x',
      stateTransport: 'kanban',
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('board "run-x" not found');
    expect(kanban.writeState).not.toHaveBeenCalled();
  });
});

describe('cleanupStaleSddWorktrees — kanban failure handling', () => {
  it('fails closed when the kanban workflow state cannot be read', async () => {
    kanban.listStates.mockRejectedValue(new Error('daemon unreachable'));

    const res = await cleanupStaleSddWorktrees({
      projectRoot: tmp,
      boardsDir: boardsDir(),
      stateTransport: 'kanban',
    });

    expect(res).toEqual({
      swept: false,
      removed: 0,
      detected: 0,
      skippedReason: 'SDD workflow state is unavailable',
    });
    expect(worktree.cleanupStale).not.toHaveBeenCalled();
  });
});

describe('destroySddProject — kanban cleanup', () => {
  function destroyPaths() {
    return {
      projectSpecs: path.join(tmp, 'specs'),
      projectTaskGraphs: path.join(tmp, 'task-graphs'),
      projectSddSession: path.join(tmp, 'sdd-session.json'),
      projectSddBoards: path.join(tmp, 'sdd-boards'),
    };
  }

  it('deletes kanban workflow states and sdd-tagged mirror boards', async () => {
    kanban.listStates.mockResolvedValue([
      { workflowId: 'sdd:run-1', revision: 1, value: snapshot() },
      { workflowId: 'sdd:run-2', revision: 1, value: snapshot({ runId: 'run-2' }) },
    ]);
    kanban.deleteState
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('delete failed'));
    kanban.listBoards.mockResolvedValue([
      { id: 'b1', tags: ['sdd'] },
      { id: 'b2', tags: ['sdd'] },
      { id: 'b3', tags: ['other'] },
      { id: 'b4' },
    ]);
    kanban.removeBoard.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const res = await destroySddProject({
      projectRoot: tmp,
      paths: destroyPaths(),
      stateTransport: 'kanban',
    });

    expect(res.deleted).toContain('workflow-states(1)');
    expect(res.deleted).toContain('kanban-mirrors(1)');
    expect(kanban.deleteState).toHaveBeenCalledWith(tmp, 'sdd:run-1');
    expect(kanban.deleteState).toHaveBeenCalledWith(tmp, 'sdd:run-2');
    expect(kanban.removeBoard).toHaveBeenCalledTimes(2);
    expect(kanban.removeBoard).toHaveBeenCalledWith(tmp, 'b1');
    expect(kanban.removeBoard).toHaveBeenCalledWith(tmp, 'b2');
  });

  it('omits the workflow-states label when every delete fails', async () => {
    kanban.listStates.mockResolvedValue([
      { workflowId: 'sdd:run-1', revision: 1, value: snapshot() },
    ]);
    kanban.deleteState.mockResolvedValue(false);

    const res = await destroySddProject({
      projectRoot: tmp,
      paths: destroyPaths(),
      stateTransport: 'kanban',
    });

    expect(res.deleted.some((label) => label.startsWith('workflow-states'))).toBe(false);
  });

  it('still destroys artifacts when kanban listing and the board store fail', async () => {
    kanban.listStates.mockRejectedValue(new Error('states unavailable'));
    kanban.listBoards.mockRejectedValue(new Error('boards unavailable'));
    const paths = destroyPaths();
    await fs.mkdir(paths.projectSpecs, { recursive: true });

    const res = await destroySddProject({
      projectRoot: tmp,
      paths,
      stateTransport: 'kanban',
    });

    expect(res.deleted).toContain('specs');
    expect(res.deleted.some((label) => label.startsWith('workflow-states'))).toBe(false);
    expect(res.deleted.some((label) => label.startsWith('kanban-mirrors'))).toBe(false);
  });
});
