import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boardPassesKindFilter, resolveKindFilter } from '../src/manager/board-kind-filter.js';
import type { KanbanBoard } from '../src/types.js';
import {
  addTask,
  createBoard,
  getKanbanOrchestrationSnapshot,
  getKanbanQueueHealth,
} from './helpers/session-manager.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-kind-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

// ── Type-level: normalizeBoard infers kind ───────────────────────────

describe('board kind normalization', () => {
  it('defaults to project when no kind, tags, or generatedBy signal session/sdd', async () => {
    const b = await createBoard(tmpDir, { title: 'Plain Project Board' });
    expect(b.kind).toBe('project');
  });

  it('infers session_mirror from session-work tag', async () => {
    const b = await createBoard(tmpDir, {
      title: 'Session',
      tags: ['session', 'session-work', 'session:abc'],
    });
    expect(b.kind).toBe('session_mirror');
  });

  it('infers session_mirror from generatedBy prefix', async () => {
    const b = await createBoard(tmpDir, {
      title: 'Mirror',
      generatedBy: 'session-kanban:sess-123',
    });
    expect(b.kind).toBe('session_mirror');
  });

  it('infers sdd_mirror from sdd tag', async () => {
    const b = await createBoard(tmpDir, {
      title: 'SDD Run',
      tags: ['sdd'],
    });
    expect(b.kind).toBe('sdd_mirror');
  });

  it('preserves explicit kind over tag inference', async () => {
    const b = await createBoard(tmpDir, {
      title: 'Explicit',
      tags: ['session-work'],
      kind: 'project',
    });
    expect(b.kind).toBe('project');
  });

  it('preserves retention policy on creation', async () => {
    const b = await createBoard(tmpDir, {
      title: 'With Retention',
      retention: { mode: 'delete_after_ttl', ttlMs: 1000 },
    });
    expect(b.retention?.mode).toBe('delete_after_ttl');
    expect(b.retention?.ttlMs).toBe(1000);
  });
});

// ── Filter resolution ────────────────────────────────────────────────

describe('resolveKindFilter', () => {
  it('defaults to excluding session_mirror and archive', () => {
    const result = resolveKindFilter(undefined);
    expect(result.exclude.has('session_mirror')).toBe(true);
    expect(result.exclude.has('archive')).toBe(true);
    expect(result.include).toBeUndefined();
  });

  it('include takes priority over exclude', () => {
    const result = resolveKindFilter({
      includeBoardKinds: ['session_mirror'],
      excludeBoardKinds: ['project'],
    });
    expect(result.include?.has('session_mirror')).toBe(true);
    expect(result.exclude.size).toBe(0);
  });

  it('explicit exclude overrides default', () => {
    const result = resolveKindFilter({
      excludeBoardKinds: ['project'],
    });
    expect(result.exclude.has('project')).toBe(true);
    expect(result.exclude.has('session_mirror')).toBe(false);
  });

  it('boardPassesKindFilter checks include set', () => {
    const board: KanbanBoard = {
      id: 'b1',
      title: 'B',
      columns: [],
      tasks: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      version: 1,
      kind: 'session_mirror',
    };
    expect(
      boardPassesKindFilter(board, { include: new Set(['session_mirror']), exclude: new Set() }),
    ).toBe(true);
    expect(
      boardPassesKindFilter(board, { include: new Set(['project']), exclude: new Set() }),
    ).toBe(false);
  });

  it('boardPassesKindFilter checks exclude set', () => {
    const board: KanbanBoard = {
      id: 'b1',
      title: 'B',
      columns: [],
      tasks: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      version: 1,
      kind: 'session_mirror',
    };
    expect(
      boardPassesKindFilter(board, { include: undefined, exclude: new Set(['session_mirror']) }),
    ).toBe(false);
    expect(
      boardPassesKindFilter(board, { include: undefined, exclude: new Set(['archive']) }),
    ).toBe(true);
  });
});

// ── Queue health board-kind filtering ────────────────────────────────

describe('getKanbanQueueHealth board-kind filtering', () => {
  it('excludes session mirror boards by default', async () => {
    const projectBoard = await createBoard(tmpDir, { title: 'Project' });
    const sessionBoard = await createBoard(tmpDir, {
      title: 'Session',
      tags: ['session', 'session-work', 'session:test'],
    });
    await addTask(tmpDir, projectBoard.id, { title: 'Task P', status: 'ready', columnId: 'todo' });
    await addTask(tmpDir, sessionBoard.id, { title: 'Task S', status: 'ready', columnId: 'todo' });

    const health = await getKanbanQueueHealth(tmpDir);
    expect(health.boardIds).toContain(projectBoard.id);
    expect(health.boardIds).not.toContain(sessionBoard.id);
  });

  it('includes session mirrors when explicitly requested', async () => {
    const sessionBoard = await createBoard(tmpDir, {
      title: 'Session',
      tags: ['session', 'session-work', 'session:test'],
    });
    await addTask(tmpDir, sessionBoard.id, { title: 'Task S', status: 'ready', columnId: 'todo' });

    const health = await getKanbanQueueHealth(tmpDir, {
      includeBoardKinds: ['session_mirror'],
    });
    expect(health.boardIds).toContain(sessionBoard.id);
  });
});

// ── Snapshot board-kind filtering ────────────────────────────────────

describe('getKanbanOrchestrationSnapshot board-kind filtering', () => {
  it('excludes session mirrors by default', async () => {
    const projectBoard = await createBoard(tmpDir, { title: 'Project' });
    const sessionBoard = await createBoard(tmpDir, {
      title: 'Session',
      tags: ['session', 'session-work', 'session:test'],
    });
    await addTask(tmpDir, projectBoard.id, { title: 'Task P', status: 'ready', columnId: 'todo' });
    await addTask(tmpDir, sessionBoard.id, { title: 'Task S', status: 'ready', columnId: 'todo' });

    const snap = await getKanbanOrchestrationSnapshot(tmpDir);
    expect(snap.boards.some((b) => b.id === projectBoard.id)).toBe(true);
    expect(snap.boards.some((b) => b.id === sessionBoard.id)).toBe(false);
  });
});
