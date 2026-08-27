import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addTask,
  adoptManagedLifecycle,
  claimReadyTask,
  copyTaskToBoard,
  createBoard,
  getBoard,
  resolveGateEnforcement,
} from './helpers/session-manager.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-enforce-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
});

const COLS = [
  { id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 },
  { id: 'todo', title: 'To Do', order: 1, wipLimit: 0 },
  { id: 'in-progress', title: 'In Progress', order: 2, wipLimit: 0 },
  { id: 'review', title: 'Review', order: 3, wipLimit: 0 },
  { id: 'done', title: 'Done', order: 4, wipLimit: 0 },
];

function managedLifecycle() {
  return {
    mode: 'managed' as const,
    columns: {
      backlog: 'backlog',
      todo: 'todo',
      running: 'in-progress',
      review: 'review',
      done: 'done',
    },
  };
}

// ── Mechanism 1: Managed boards accept Backlog drafts, then validate transitions ───────────

describe('managed-board task creation', () => {
  it('rejects a title-only task on a managed board at creation', async () => {
    const b = await createBoard(tmpDir, { title: 'M', lifecycle: managedLifecycle() });
    await expect(addTask(tmpDir, b.id, { title: 'No description' })).rejects.toThrow('description');
  });

  it('accepts a task with description on a managed board', async () => {
    const b = await createBoard(tmpDir, { title: 'M', lifecycle: managedLifecycle() });
    const result = await addTask(tmpDir, b.id, {
      title: 'With description',
      description: 'A properly scoped task with clear intent.',
    });
    expect(result).not.toBeNull();
    expect(result!.task.lifecycle?.currentStage).toBe('backlog');
  });

  it('accepts a title-only task on a legacy board (backward compat)', async () => {
    const b = await createBoard(tmpDir, { title: 'Legacy' });
    const result = await addTask(tmpDir, b.id, { title: 'Title only' });
    expect(result).not.toBeNull();
    expect(result!.task.title).toBe('Title only');
  });

  it('rejects copyTaskToBoard to a managed board when source has no description', async () => {
    const legacy = await createBoard(tmpDir, { title: 'Legacy' });
    const managed = await createBoard(tmpDir, { title: 'M', lifecycle: managedLifecycle() });
    const source = await addTask(tmpDir, legacy.id, { title: 'No desc' });
    await expect(copyTaskToBoard(tmpDir, legacy.id, source!.task.id, managed.id)).rejects.toThrow(
      'description',
    );
  });

  it('accepts copyTaskToBoard to a managed board when source has description', async () => {
    const legacy = await createBoard(tmpDir, { title: 'Legacy' });
    const managed = await createBoard(tmpDir, { title: 'M', lifecycle: managedLifecycle() });
    const source = await addTask(tmpDir, legacy.id, {
      title: 'Has desc',
      description: 'Real scope.',
    });
    const result = await copyTaskToBoard(tmpDir, legacy.id, source!.task.id, managed.id);
    expect(result).not.toBeNull();
    expect(result!.task.lifecycle?.currentStage).toBe('backlog');
  });
});

// ── Mechanism 2: Deterministic dispatch ordering ──────────────────────

describe('claimReadyTask: deterministic board ordering', () => {
  it('claims from the most-recently-updated board first', async () => {
    const boardA = await createBoard(tmpDir, { title: 'Board A' });
    const boardB = await createBoard(tmpDir, { title: 'Board B' });

    // Add ready tasks to both boards
    await addTask(tmpDir, boardA.id, { title: 'Task A', status: 'ready', columnId: 'todo' });
    await addTask(tmpDir, boardB.id, { title: 'Task B', status: 'ready', columnId: 'todo' });

    // Touch boardB after boardA so boardB.updatedAt is newer
    await addTask(tmpDir, boardB.id, { title: 'Task B2', status: 'pending' });

    // Claim should pick from boardB (more recently updated)
    const claimed = await claimReadyTask(tmpDir, { agentId: 'test-agent' });
    expect(claimed).not.toBeNull();
    expect(claimed!.board.id).toBe(boardB.id);
  });

  it('rotates after a successful global claim so active boards cannot starve older boards', async () => {
    const boardA = await createBoard(tmpDir, { title: 'A' });
    const boardB = await createBoard(tmpDir, { title: 'B' });

    await addTask(tmpDir, boardA.id, { title: 'older ready', status: 'ready', columnId: 'todo' });
    await addTask(tmpDir, boardB.id, { title: 'newer ready 1', status: 'ready', columnId: 'todo' });
    await addTask(tmpDir, boardB.id, { title: 'newer ready 2', status: 'ready', columnId: 'todo' });

    const first = await claimReadyTask(tmpDir, { agentId: 'test' });
    expect(first).not.toBeNull();
    expect(first!.board.id).toBe(boardB.id);

    const second = await claimReadyTask(tmpDir, { agentId: 'test2' });
    expect(second).not.toBeNull();
    expect(second!.board.id).toBe(boardA.id);
  });
});

// ── Mechanism 3: Strict completion gate on adoption ───────────────────

describe('adoptManagedLifecycle: strict completion gate', () => {
  it('sets completionGate.enforcement to strict on adoption', async () => {
    const b = await createBoard(tmpDir, { title: 'Legacy', columns: COLS });
    const adopted = await adoptManagedLifecycle(tmpDir, b.id, {
      columns: managedLifecycle().columns,
      actor: 'test',
      comment: 'Adopting for deterministic enforcement.',
    });

    expect(adopted?.completionGate?.enforcement).toBe('strict');
    expect(resolveGateEnforcement(adopted!)).toBe('strict');
  });

  it('converts an existing off gate to strict on adoption', async () => {
    const b = await createBoard(tmpDir, {
      title: 'Legacy with off gate',
      columns: COLS,
      completionGate: { enforcement: 'off' },
    });
    const adopted = await adoptManagedLifecycle(tmpDir, b.id, {
      columns: managedLifecycle().columns,
      actor: 'test',
      comment: 'Adopting and hardening gate.',
    });

    expect(adopted?.completionGate?.enforcement).toBe('strict');
  });

  it('preserves an explicit soft gate on adoption', async () => {
    const b = await createBoard(tmpDir, {
      title: 'Legacy with soft gate',
      columns: COLS,
      completionGate: { enforcement: 'soft' },
    });
    const adopted = await adoptManagedLifecycle(tmpDir, b.id, {
      columns: managedLifecycle().columns,
      actor: 'test',
      comment: 'Adopting but keeping soft.',
    });

    // Soft is explicitly preserved — only 'off' and undefined are upgraded
    expect(adopted?.completionGate?.enforcement).toBe('soft');
  });
});

// ── Mechanism 1+2: Managed transition detail enforcement prevents fake progress ──

describe('Anti-fake-progress: managed lifecycle blocks empty cards', () => {
  it('prevents creating a description-less card on a managed board', async () => {
    const b = await createBoard(tmpDir, { title: 'M', lifecycle: managedLifecycle() });
    await expect(addTask(tmpDir, b.id, { title: 'Empty' })).rejects.toThrow();

    // Board should have no tasks (the mutation was rejected)
    const stored = await getBoard(tmpDir, b.id);
    expect(stored?.tasks).toHaveLength(0);
  });
});
